const debug = require('debug')('spikenail:MongoAccessMap');
const hl = require('debug')('hl');

const clone = require('lodash.clone');
const isPlainObject = require('lodash.isplainobject');

const md5 = require('md5');

const sift = require('sift');

import mongoose from 'mongoose';

import Spikenail from '../Spikenail';

/**
 * Access map for mongo models
 * TODO: extend base accessmap ?
 */
export default class MongoAccessMap {

  /**
   * Wraps model to build an access map
   *
   * @param model
   * @param ctx
   * @param options
   */
  constructor(model, ctx, options = {}) {
    debug(model.getName(), 'constructor', options);

    // TODO: filter by requested fields

    this.model = model;

    this.ctx = ctx;

    this.options = options;

    this.sourceACLs = clone(model.getACLs());

    //let staticRoles = this.model.getStaticRoles(ctx);
    this.staticRoles = this.model.getStaticRoles(ctx);

    this.dynamicRoles = this.model.getRealDynamicRoles(ctx);
  }

  /**
   * Initialize map
   *
   * @returns {Promise.<void>}
   */
  async init() {
    debug(this.model.getName(), 'initialize access map');

    // TODO: move this stuff on app initialization step
    // Handle rule injecting
    // TODO: deprecate injection stuff for now as looks like it is not very useful
    // let replaceMap = {};
    // for (let [index, rule] of this.sourceACLs.entries()) {
    //   let model = this.getInjectRelationModel(rule);
    //
    //   if (!model) {
    //     continue;
    //   }
    //
    //   hl('Injection model found:', model.getName());
    //
    //   // Create access map for the
    //   let opts = {};
    //   if (rule.action) {
    //     opts.action = rule.action;
    //   }
    //   let injectAccessMap = new MongoAccessMap(model, this.ctx, Object.assign(this.options, opts));
    //   await injectAccessMap.init();
    //
    //   // TODO: we have to throw an error if it has dependent rules as we are likely to unable handle this case for now
    //   // TODO: not sure about nested injection
    //   if (injectAccessMap.hasAtLeastOneTrueValue()) {
    //     hl('inject map has true value');
    //     // allow all
    //     replaceMap[index] = [{
    //       allow: true,
    //       fields: ['*'],
    //       roles: ['*'],
    //       actions: [this.options.action]
    //     }]
    //   } else if (injectAccessMap.isFails()) {
    //     hl('inject map fails');
    //     // build query
    //     replaceMap[index] = [{
    //       allow: false,
    //       fields: ['*'],
    //       roles: ['*'],
    //       actions: [this.options.action]
    //     }]
    //   } else {
    //     hl('accessmap is not determined');
    //     // Unable to instantly determine an access based on static roles
    //     // build query and use it as scope
    //
    //     // An issue - constructor is not async stuff
    //     let query = await injectAccessMap.getQuery();
    //     hl('inject query is %j', query);
    //     // TODO: we could possibly pick up the query of _id/or lists field only
    //     // TODO: means simplest query that will give us allow true value
    //
    //     // Synthetic rule where scope is query on dependent model
    //     replaceMap[index] = [{
    //       // Disallow everything by default
    //       allow: false,
    //       fields: ['*'],
    //       roles: ['*'],
    //       actions: [this.options.action]
    //     }, {
    //       // allow only in case we allow to access dependent relation
    //       allow: true,
    //       fields: ['*'],
    //       roles: ['*'],
    //       //test: 123,
    //       scope: function () { return query },
    //       actions: [this.options.action],
    //       checkRelation: model.getName()
    //     }]
    //   }
    // }
    //
    // debug('replaceMap', replaceMap);
    //
    // for (let index of Object.keys(replaceMap)) {
    //   let rules = replaceMap[index];
    //
    //   debug('replacing', rules);
    //
    //   // replace inject rule with rules
    //   this.sourceACLs.splice(index, 1, ...rules);
    //
    //   debug('after splice');
    // }
    //
    // hl('acls after injection %j', this.sourceACLs, this.sourceACLs);

    // Filter model acls according to specified options
    if (this.options.onlyDependentRules) {
      debug(this.model.getName(), 'access map is only for dependent rules');
      this.acls = this.sourceACLs.filter(rule => {
        return this.isDeferredRule(rule);
      })
    }

    // TODO: remove ctx from arguments - it is possible to access it by this.ctx
    this.acls = this.sourceACLs
      .filter(this.isRuleMatchAction(this.options.action)) // TODO: defaults? throw error?
      .map(this.removeImpossibleRoles.bind(this, this.ctx))
      .filter(rule => !!rule.roles.length)
      .map(this.filterRuleProperties.bind(this, this.options.properties))
      .filter(rule => !!rule);

    // Store flags to check what data has already built
    this.built = {};

    // Build map without queries
    this.accessMap = await this.buildAccessMap(this.acls);

    // Save some initial properties
    // TODO: not sure how to implement it better, so let's use quick fix for now
    // TODO: the issue is that we might apply some data and change actual rules
    // TODO: but we still need some metrics based on initial data to make some decisions
    this.initialProps = {};
    this.initialProps.hasDependentRules = this.hasDependentRules();
    this.initialProps.hasAtLeastOneTrueValue = this.hasAtLeastOneTrueValue();
  }

  /**
   * Remove unmatched properties if specified
   *
   * @param properties
   * @param sourceRule
   * @returns {*}
   */
  filterRuleProperties(properties, sourceRule) {
    if (!properties) {
      return sourceRule;
    }

    let rule = clone(sourceRule);

    if (~rule.properties.indexOf('*')) {
      return rule;
    }

    rule.properties = rule.properties.filter(prop => ~properties.indexOf(prop));

    if (!rule.properties.length) {
      return null;
    }

    return rule;
  }

  /**
   * ??? not sure
   * @returns {*}
   */
  props() {
    return this.accessMap
  }

  /**
   * special rule that inject rules from the other model
   *
   * @param rule
   * @returns {boolean}
   */
  isInjectRule(rule) {
    return !!rule.test;
  }

  /**
   *
   * @param rule
   */
  getInjectRelation(rule) {
    if (!this.isInjectRule(rule)) {
      return null;
    }

    return this.model.schema.properties[rule.test];
  }

  /**
   * Get the model from which we need to inject rules
   *
   * @param rule
   * @returns {null}
   */
  getInjectRelationModel(rule) {
    let rel = this.getInjectRelation(rule);

    if (!rel) {
      return null;
    }

    return Spikenail.models[rel.ref];
  }

  /**
   * Get rules that need to inject
   *
   * @deprecated
   *
   * @param rule
   */
  getInjectionRules(rule) {
    debug('getInjectionRules for', rule);

    let model = this.getInjectRelationModel(rule);
    if (!model) {
      return null;
    }

    let acls = model.getACLs();

    if (!acls.length) {
      return null;
    }

    // Iterate through rules and adopt them
    acls = clone(acls);
    acls = acls.map(rule => {

      if (rule.checkRelation) {
        throw new Error('Unable to inject rules from model that have dependent rules');
      }

      if (this.isInjectRule(rule)) {
        throw new Error('Unable to inject rules from model that also inject rules');
      }

      rule.checkRelation = model.getName();

      return rule;
    });

    debug('injection rules found', acls);

    return acls;
  }


  /**
   * Builds access map from acls
   *
   * Property will receive boolean value, or if rule is deferred
   *
   * Applies ACL rules on model properties
   * Might be deferred
   * TODO: cond function could return static value - e.g. false, or true.
   * TODO: if, for example, user is anonymous
   * TODO: think later how it should be implemented
   *
   * @param acls raw schema acl rules defined by user
   */
  async buildAccessMap(acls) {

    debug(this.model.getName(), 'buildAccessMap, acls:', acls);

    let ctx = this.ctx;

    // TODO: we should probably filter and prepare ACL rules in one method.
    // TODO: as it is not obvious that this method requires filtered ACLs
    // TODO: think later what name of the function and args are better

    // Initialize the access map of properties
    let accessMap = {};

    let initialProps = this.options.properties || Object.keys(this.model.schema.properties);
    initialProps.forEach(field => {
      // By default, everything is allowed
      accessMap[field] = true;
    });

    for (let [index, rule] of acls.entries()) {
      debug(this.model.getName(), 'processing rule: %o', rule);

      let applyValue = rule.allow;

      // First of all lets check if it is dependent rule and could be resolved in place
      if (this.isDependentRule(rule)) {
        debug(this.model.getName(), 'rule is dependent, try to resolve');
        let depModel = this.getDependentModel(rule);

        // Build access map for dependent model
        // TODO: memoize

        let opts = { roles: rule.roles };

        // Ability to specify for which action we are checking access relation
        if (rule.checkAction) {
          opts.action = rule.checkAction;
          opts.properties = null;
          opts.onlyDependentRules = null;
        }

        let depAccessMap = new MongoAccessMap(
          depModel,
          this.ctx,
          Object.assign(
            clone(this.options),
            opts
          )
        );
        await depAccessMap.init();

        debug(this.model.getName(), 'dependent access map initialized: %o', depAccessMap.accessMap);

        // Currently, check for at least one true value for given roles of course
        if (depAccessMap.hasAtLeastOneTrueValue()) {
          debug(this.model.getName(), 'rule resolved to true (at least one true)');
          applyValue = true;
        } else if (depAccessMap.isFails()) {
          debug(this.model.getName(), 'rule resolved to false (all false)');
          applyValue = false;
        } else {
          debug(this.model.getName(), 'can not resolve in place, build the query');
          // Unable to instantly determine an access based on static roles
          // build query and use it as scope

          // An issue - constructor is not async stuff
          let query = await depAccessMap.getQuery();
          debug(this.model.getName(), 'dependent map query is %j', query);
          // TODO: we could possibly pick up the query of _id/or lists field only
          // TODO: means simplest query that will give us allow true value

          // Synthetic rule where scope is query on dependent model
          applyValue = {
            // allow only in case we allow to access dependent relation
            allow: true,
            fields: ['*'],
            roles: ['*'],
            //test: 123,
            scope: function () { return query },
            actions: [this.options.action],
            checkRelation: depModel.getName()
          }
        }
      } else if (this.isDeferredRule(rule)) {
        debug(this.model.getName(), 'rule is deferred, will calculate it later');
        applyValue = clone(rule);
      }

      debug(this.model.getName(), 'resulting apply value: %o', applyValue);

      // Apply rule to specific properties of model
      for (let prop of rule.properties) {
        if (prop === '*') {
          // Properties could be manually specified by user
          let props = this.options.properties || Object.keys(accessMap);

          for (let prop of props) {
            // TODO: no time to think why we need all these clone statements
            accessMap[prop] = clone(this.getNewApplyValue(clone(accessMap[prop]), clone(applyValue)));
          }
          break;
        }

        // We have to check current value
        accessMap[prop] = clone(this.getNewApplyValue(clone(accessMap[prop]), clone(applyValue)));
      }
    }

    debug(this.model.getName(), 'resulting accessMap', accessMap);

    return accessMap;
  }

  /**
   * Get new apply value
   *
   * @param prevValue
   * @param applyValue
   */
  getNewApplyValue(prevValue, applyValue) {
    // Algorithm that applies value on access map property

    // If strict value just apply as is
    if (typeof(applyValue) === 'boolean') {
      return applyValue;
    }

    // If apply value if rule object

    // Check if previous value is boolean
    if (typeof(prevValue) === 'boolean') {
      // If previous value is boolean
      // Replace it with apply value only if it inverts allow value
      if (prevValue !== applyValue.allow) {
        return {
          rules: [applyValue]
        }
      }

      // Otherwise return prev value
      return prevValue;
    }

    // If prev value is object with rule set, just push additional rule
    prevValue.rules.push(applyValue);

    return prevValue;
  }


  /**
   * Build rule queries
   */
  buildRuleQueries() {
    let ctx = this.ctx;

    debug(this.model.getName(), 'building rule queries');

    for (let key of Object.keys(this.accessMap)) {
      let value = this.accessMap[key];

      if (typeof(value) === 'boolean') {
        continue;
      }

      //let ruleSet = value.rules;

      // calculate unique rule set hash
      //let hash = this.toHash(ruleSet);

      // TODO: memoize
      this.createRuleQueriesForMapValue(value);

      // we should convert rule set to query only once
      // if (queries[hash]) {
      //   accessMap[key] = queries[hash];
      //   continue;
      // }
      //
      // let queryVal = this.ruleSetToQuery(ruleSet, ctx);
      // accessMap[key] = queryVal;
      // queries[hash] = queryVal;
    }

    debug(this.model.getName(), 'map with rule queries %j', this.accessMap);

    this.built.ruleQueries = true;
  }

  /**
   * Create individual queries for each rule of map value
   *
   * @param sourceValue
   */
  createRuleQueriesForMapValue(sourceValue) {
    let ctx = this.ctx;

    let value = clone(sourceValue);

    // Lets expand each rule in rule set
    // That mean convert role to condition and merge it with scope
    // Build queries set. Convert each individual rule to query
    // we assume that there is only dynamic roles left

    for (let rule of value.rules) {
      let model = this.isDependentRule(rule) ? this.getDependentModel(rule) : this.model;

      let query = {};

      if (rule.scope) {
        // TODO: what arguments?
        query = rule.scope();
      }

      if (!rule.roles) {

        // TODO: it assumes that we have only correct rules here
        rule.query = query;
        continue;
      }

      let conds = [];
      // Finding only dynamic roles
      for (let roleName of rule.roles) {
        let role = model.schema.roles ? model.schema.roles[roleName] : null;

        if (!role) {
          // This actually could happen because our rule might be dynamic only because of scope
          continue;
        }

        // Execute handler
        // TODO: could it be async? On what data it depends? Should we execute it multiple times?
        let calculatedCond = role.cond(ctx);

        if (typeof calculatedCond === 'boolean') {
          // Not obvious but we skip boolean valued here, as it actually acts as static role
          // and should've been handled before. We can't to anything with boolean at this step
          continue;
        }

        let cond = Object.assign(calculatedCond, query);
        conds.push(cond);
      }

      if (!conds.length) {
        // return {
        //   allow: rule.allow,
        //   query: query
        // };

        rule.query = query;
        continue;
      }

      let result = {};

      // check if more than one condition
      if (conds.length > 1) {
        result = { '$or': conds }
      } else {
        result = conds[0];
      }

      rule.query = result;
    }
  }

  /**
   * Build query for every ruleset in accessmap values
   */
  buildRuleSetQueries() {
    debug(this.model.getName(), 'building rule set queries');

    // anyway need to iterate all values
    for (let key of Object.keys(this.accessMap)) {
      // Lets merge all queries set to single query
      let value = this.accessMap[key];

      // TODO not sure
      if (typeof(value) === 'boolean') {
        continue;
      }

      let mergedQuery = {};

      // TODO: use bind instead
      let self = this;
      let toQuery = function(next, arr) {
        let item = arr.pop();

        let key = '$or';
        let query = item.query;
        if (!item.allow) {
          key = '$and';
          query = self.invertMongoQuery(item.query);
        }

        // If last item
        if (!arr.length) {
          Object.assign(next, query);
          return;
        }

        let newNext = {};
        next[key] =[newNext, query];

        toQuery(newNext, arr);
      };

      toQuery(mergedQuery, value.rules.slice(0));
      value.query = mergedQuery;
    }

    debug(this.model.getName(), 'Resulting access map with rule set queries', this.accessMap);
    this.built.ruleSetQueries = true;
  }

  /**
   * Convert the whole access map to single query if possible
   */
  async getQuery() {
    // TODO: cache the result?

    debug(this.model.getName(), 'getting single query');

    // Handle dependencies
    if (!this.built.ruleQueries) {
      this.buildRuleQueries();
    }

    if (!this.built.ruleSetQueries) {
      this.buildRuleSetQueries();
    }

    let queries = {};

    for (let ruleSet of Object.values(this.accessMap)) {
      if (typeof(ruleSet) === 'boolean') {
        continue;
      }

      // calculate unique rule set hash
      // TODO: make another unique check
      let hash = this.toHash(ruleSet);

      // we should convert rule set to query only once
      if (queries[hash]) {
        continue;
      }

      queries[hash] = ruleSet.query;
    }

    queries = Object.values(queries);

    if (!queries.length) {
      return null;
    }

    // TODO: Probably use something like conditionsToOrQuery
    if (queries.length > 1) {
      return { '$or': queries };
    }

    return queries[0];
  }

  /**
   * To hash
   * @param data
   */
  toHash(data) {
    return md5(JSON.stringify(data));
  }

  /**
   * Invert mongodb query. Not all queries are supported.
   * One should avoid specifying a condition with { "allow": false }
   * as automatic inversion might give unexpected result
   *
   * TODO: move to separate npm module
   * TODO: ( { qty: { $exists: true, $nin: [ 5, 15 ] } } )
   * TODO: invert $not
   *
   * @param sourceQuery
   */
  invertMongoQuery(sourceQuery) {
    let invertedQuery = {};

    for (let key of Object.keys(sourceQuery)) {
      //debug('iterate key', key);
      let val = sourceQuery[key];

      if (key.startsWith('$')) {
        if (key == '$and') {
          // Invert every item
          // wrap into $nor
          invertedQuery['$nor'] = [{
            '$and': val
          }];
        } else if (key == '$or') {
          // change to $nor
          invertedQuery['$nor'] = val;
        } else {
          throw new Error('Can not invert query. Unsupported top-level operator');
        }


        continue;
      }


      // Operator replace map
      /*
       Note that: { $not: { $gt: 1.99 } } is different from the $lte operator

       db.inventory.find( { price: { $not: { $gt: 1.99 } } } )
       This query will select all documents in the inventory collection where:

       the price field value is less than or equal to 1.99 or
       the price field does not exist

       This way it is better to avoid $not
       */
      let replaceMap = {
        '$in': '$nin',
        '$nin': '$in',
        '$gt': '$lte',
        '$lte': '$gt',
        '$lt': '$gte',
        '$gte': '$lt',
        '$ne': '$eq'
      };

      // Check if field value is expression
      if (isPlainObject(val) && Object.keys(val)[0].startsWith('$')) {
        let operator = Object.keys(val)[0];
        // If possible, try to replace operator
        if (replaceMap[operator]) {
          invertedQuery[key] = {
            [replaceMap[operator]]: val[operator]
          };
          continue;
        }

        // TODO: can we do more? Wrap into $not for example
        throw new Error('Can not invert query. Unsupported operators', sourceQuery);
      } else {
        // Invert boolean
        // If we will use $ne here then empty values could unexpectedly match
        if (typeof(val) === "boolean") {
          invertedQuery[key] = !val;
          continue;
        }

        // For other values use $ne to invert value
        invertedQuery[key] = { '$ne': val };
      }
    }

    return invertedQuery;
  }

  /**
   * Check that all elements of access map equals false
   *
   * @returns {boolean}
   */
  isFails() {
    return Object.values(this.accessMap).every(item => {
      if (typeof(item) !== "boolean") {
        return false;
      }

      return !item;
    });
  }

  /**
   * Check that all values are boolean true values
   *
   * @returns {boolean|*}
   */
  isPassing() {
    return Object.values(this.accessMap).every(item => {
      if (typeof(item) !== "boolean") {
        return false;
      }

      return !!item;
    });
  }

  /**
   * If access map
   * If at least one value of access map is true
   *
   * @returns {boolean}
   */
  hasAtLeastOneTrueValue() {
    for (let val of Object.values(this.accessMap)) {
      if (typeof(val) === 'boolean' && val) {
        return true;
      }
    }

    return false;
  }

  /**
   *
   * @returns {boolean}
   */
  hasAtLeastOneFalseValue() {
    for (let val of Object.values(this.accessMap)) {
      if (typeof(val) === 'boolean' && !val) {
        return true;
      }
    }

    return false;
  }


  /**
   * Check if finally access map has dependent models in it
   * So conditions might not be fully calculated
   *
   * @returns {boolean}
   */
  hasDependentRules() {
    for (let val of Object.values(this.accessMap)) {
      if (typeof(val) === 'boolean') {
        continue;
      }

      for (let rule of val.rules) {
        if (this.isDependentRule(rule)) {
          return true;
        }
      }
    }

    return false;
  }


  /**
   * Check if rule match action
   *
   * @param action
   * @returns {Function}
   */
  isRuleMatchAction(action) {
    return function(rule) {
      if (!~rule.actions.indexOf('*') && !~rule.actions.indexOf(action)) {
        return false;
      }

      return true;
    }
  }

  /**
   * Returns compiled query for querying all dependent documents
   * Grouped by model
   *
   * @returns {object}
   */
  getCompiledDependentModelQueries() {

    debug(this.model.getName(), 'getCompiledDependentModelQueries');

    // depends on buildRuleQueries
    // Requires individual rule queries to be built first
    if (!this.built.ruleQueries) {
      this.buildRuleQueries();
    }

    let models = {};

    // TODO: Could be simplified a lot
    for (let val of Object.values(this.accessMap)) {
      if (typeof(val) === 'boolean') {
        continue;
      }

      let dependentRules = val.rules.filter(this.isDependentRule);
      if (!dependentRules.length) {
        continue;
      }

      dependentRules.forEach(rule => {

        let model = this.getDependentModel(rule);
        if (!models[model.getName()]) {
          models[model.getName()] = {
            queries: [],
            model: model
          };
        }
        models[model.getName()].queries.push(rule.query);
      })
    }

    // compile queries for each model
    for (let modelQueries of Object.values(models)) {
      modelQueries.query = this.queriesToOrQuery(modelQueries.queries);
    }

    return models;
  }

  /**
   * Convert rule to strict rule. Trims scopes, roles
   *
   * @deprecated
   *
   * @param rule
   */
  ruleToStrict(rule) {
    // TODO should we clone and return new rule
    delete rule.scope;
    rule.roles = ['*']; // Do we actually need it?
  }

  /**
   * Returns only dependent rules
   *
   * TODO: no very optimal approach
   */
  getDependentRules() {
    let result = [];

    let ids = new Set();

    for (let prop of Object.keys(this.accessMap)) {

      let val = this.accessMap[prop];

      if (typeof(val) === 'boolean') {
        continue;
      }

      let dependentRules = val.rules.filter(this.isDependentRule);
      if (!dependentRules.length) {
        continue;
      }

      dependentRules.forEach(rule => {
        let ruleId = JSON.stringify(rule);
        if (!ids.has(ruleId)) {
          result.push(rule);
          ids.add(ruleId);
        }
      });
    }

    return result;
  }

  /**
   * Apply dependent data
   * TODO: call dependent methods
   *
   * @param data
   */
  applyDependentData(data) {

    debug(this.model.getName(), 'applying dependent data %j', data);

    if (!this.built.ruleQueries) {
      this.buildRuleQueries();
    }

    // Now we need to filter data using sift
    for (let prop of Object.keys(this.accessMap)) {
      // TODO we are replacing same val multiple times
      let val = this.accessMap[prop];

      if (typeof(val) === 'boolean') {
        continue;
      }

      let dependentRules = val.rules.filter(this.isDependentRule);
      if (!dependentRules.length) {
        continue;
      }

      dependentRules.forEach(rule => {

        let model = this.getDependentModel(rule);
        let modelName = model.getName();

        // TODO optimize - no need to reapply same query to the same data
        let queryResult = sift(rule.query, data[modelName].data);

        if (!queryResult.length) {
          // Mark accessMap value as need to be recalculated
          val.recalc = true;

          // Convert rule to strict rule
          //this.ruleToStrict(rule);
          rule.recalc = true;
        } else {

          // Get relation to check in order to extract foreignKey name
          let relation = this.model.schema.properties[rule.checkRelation];
          let foreignKey = relation.foreignKey;
          let property = this.model.schema.properties[foreignKey];

          // should we fix the library
          let newQuery = {[foreignKey]: {'$in': queryResult.map(doc =>
            doc._id
          )}};

          // Store orig query just in case
          rule.origQuery = rule.query;
          rule.query = newQuery;
        }
      });

      // Recalculate the whole value if needed
      if (!val.recalc) {
        continue;
      }

      let rules = clone(val.rules);
      // Clear current ruleset
      //delete val.rules;

      this.accessMap[prop] = {
        rules: []
      };

      for (let [index, rule] of rules.entries()) {

        let applyValue = !rule.allow; // TODO: will it actually work?

        if (!rule.recalc) {
          applyValue = clone(rule);
        }

        this.accessMap[prop] = this.getNewApplyValue(this.accessMap[prop], applyValue);
      }

      debug('recalculated prop', prop, this.accessMap[prop]);
    }

    debug(this.model.getName(), 'access map with applied data', this.accessMap);
  }

  /**
   * Build single query from array of queries
   *
   * @param queries
   */
  queriesToOrQuery(queries) {
    // check if more than one condition
    if (queries.length > 1) {
      return { '$or': queries }
    }

    return queries[0];
  }

  /**
   * Remove impossible roles
   *
   * @param ctx
   * @param sourceRule
   */
  removeImpossibleRoles(ctx, sourceRule) {
    let rule = clone(sourceRule);

    // If rule * exists - left only it
    // TODO: should be on app initialization step
    if (~rule.roles.indexOf('*')) {
      rule.roles = ['*'];
      return rule;
    }

    // Get dynamic roles for model from current model or related
    let dynamicRoles = this.isDependentRule(rule)
      ? this.getDependentModel(rule).getPossibleDynamicRoleNames(ctx)
      : this.model.getPossibleDynamicRoleNames(ctx);

    let roles = [];

    let matchedStaticRoles = this.getMatchedRoles(rule, this.staticRoles);
    roles = roles.concat(matchedStaticRoles);

    // todo should be on app init step
    let matchedDynamicRoles = this.getMatchedRoles(rule, dynamicRoles);

    roles = roles.concat(matchedDynamicRoles);

    // It is possible to manually specify roles for which we will build access map
    // TODO: don't like it placed here. The function should only remove impossible roles
    // TODO: and not do anything else
    if (this.options.roles && !~this.options.roles.indexOf('*')) {
      roles = this.options.roles;
    }

    // remove all roles that not in matched roles
    rule.roles = rule.roles.filter(role => {
      return ~roles.indexOf(role);
    });

    return rule;
  }

  /**
   * Check if rule is deferred - allow value could not be calculated immediately
   *
   * @param rule
   */
  isDeferredRule(rule) {
    // TODO: the purpose of this is not really clear. Change algorithm

    if (rule.scope) {
      return true;
    }

    // TODO: not sure it wasn't handled before
    if (~rule.roles.indexOf('*')) {
      return false;
    }

    if (this.isRuleMatchRoles(rule, Object.keys(this.dynamicRoles))) {
      return true;
    }

    return false;

    // return (rule.scope || (!~rule.roles.indexOf('*') && !this.isRuleMatchRoles(rule, this.staticRoles)))
  }

  /**
   * Check if rule match any of given roles
   *
   * @param rule
   * @param roles
   * @returns {boolean}
   */
  isRuleMatchRoles(rule, roles) {
    return !!rule.roles.filter(r => ~roles.indexOf(r)).length;
  }

  /**
   * Match rule with "roles" and return array of matched rule roles
   *
   * @param rule
   * @param roles
   * @returns {Array.<T>}
   */
  getMatchedRoles(rule, roles) {
    return rule.roles.filter(r => ~roles.indexOf(r));
  }


  /**
   * Check if rule depends on another model
   *
   * @param rule
   * @returns {boolean}
   */
  isDependentRule(rule) {
    return !!rule.checkRelation;
  }

  /**
   * Get model that rule depends on
   * @param rule
   * @returns {*}
   */
  getDependentModel(rule) {
    return Spikenail.models[rule.checkRelation];
  }
}