import _ from 'lodash';
import Promise from 'bluebird';
import sentry from '../sentry/index';
import moment from 'moment';
import uuid from 'uuid';
import Ring from 'ringjs';
import neo4j from '../driver/index';
import ql from '../data/queries/query-library';

/**
 * This is a controller for clusters.
 * 
 * Beware, by "Clusters" here we mean any number of neo4j nodes.
 * A standalone single instance on desktop is here thought of as
 * a cluster of 1.
 * 
 * This class exists to coordinate administrative actions that
 * should be inherently cross-cluster.
 * 
 * For example, if you wanted to make a dynamic config change,
 * add a user, and so on.
 */
const clusterOpSuccess = (node, results) => ({
    success: true, node, addr: node.getBoltAddress(), results,
});

const clusterOpFailure = (node, err) => {
    if (err) { sentry.reportError(err); }
    return {
        success: false, node, addr: node.getBoltAddress(), err,
    };
};

const packageClusterOpResults = results => {
    // Overall we're a success only if all underlying promises
    // were.  Otherwise we failed.
    const success = 
        results.filter(r => r.success).length === results.length;

    // Incude results so that we can see individual
    // operation failures if appropriate.
    return { success, results };
};

const MAX_EVENTS = 200;

export default class ClusterManager {
    constructor(halinCtx) {
        this.ctx = halinCtx;
        this.eventLog = new Ring(MAX_EVENTS);
    }

    addEvent(event) {
        if (!event.message || !event.type) {
            throw new Error('ClusterManager events must have at least message, type');
        }

        // Don't modify caller's argument.
        const data = _.cloneDeep(event);
        _.set(data, 'date', moment.utc().toISOString());
        _.set(data, 'payload', event.payload || null);
        _.set(data, 'id', uuid.v4());
        this.eventLog.push(data);
    }

    getEventLog() {
        return this.eventLog.toArray();
    }

    /**
     * Map a query across all cluster members in parallel.
     * 
     * @param query the cypher query
     * @param params cypher query params.
     * 
     * @return {Promise} of an object with { success, results }.
     * Success is true only if all underlying queries succeeded.
     * Results is an array of result objects from each individual
     * query.  
     */
    mapQueryAcrossCluster(query, params) {
        const promises = this.ctx.members().map(node => {
            // Guarantee that promise resolves.
            // it resolves to an object that indicates success
            // or failure.
            return node.run(query, params)
                .then(results => clusterOpSuccess(node, results))
                .catch(err => clusterOpFailure(node, err));
        });

        return Promise.all(promises)
            .then(packageClusterOpResults);
    }

    addUser(user) {
        const { username, password } = user;
        if (!user || !password) {
            throw new Error('Call with object containing keys username, password');
        }

        return this.mapQueryAcrossCluster(
            'CALL dbms.security.createUser({username}, {password}, false)',
            { username, password }
        )
            .then(result => {
                this.addEvent({
                    type: 'adduser',
                    message: `Added user "${username}"`,
                    payload: username,
                });
                return result;
            })
    } 

    deleteUser(user) {
        const { username } = user;
        if (!username) {
            throw new Error('Call with an object containing keys username');
        }

        return this.mapQueryAcrossCluster(
            'CALL dbms.security.deleteUser({username})',
            { username }
        )
            .then(result => {
                this.addEvent({
                    type: 'deleteuser',
                    message: `Deleted user "${username}"`,
                    payload: username,
                });
                return result;
            })
    }

    addRole(role) {
        if (!role) { throw new Error('Must provide role'); }

        return this.mapQueryAcrossCluster(
            'CALL dbms.security.createRole({role})',
            { role }
        )
            .then(result => {
                this.addEvent({
                    type: 'addrole',
                    message: `Created role "${role}"`,
                    payload: role,
                });
                return result;
            });
    }

    deleteRole(role) {
        if (!role) throw new Error('Must provide role');

        return this.mapQueryAcrossCluster(
            'CALL dbms.security.deleteRole({role})',
            { role }
        )
            .then(result => {
                this.addEvent({
                    type: 'deleterole',
                    message: `Deleted role "${role}"`,
                    payload: role,
                });
                return result;
            });
    }

    /** Specific to a particular node */
    addNodeRole(node, username, role) {
        sentry.info('ADD ROLE', { username, role });
        return node.run('call dbms.security.addRoleToUser({role}, {username})', { username, role });
    }

    /** Specific to a particular node */
    removeNodeRole(node, username, role) {
        sentry.info('REMOVE ROLE', { username, role });
        return node.run('call dbms.security.removeRoleFromUser({role}, {username})', { username, role });
    }

    /**
     * @param {Object} user 
     * @param {Array} roles 
     * @returns {Promise} that resolves to a clusterOp result
     */
    associateUserToRoles(user, roles) {
        sentry.info(`CM associate ${user} to ${roles}`);
        if (!_.isArray(roles)) { 
            throw new Error('roles must be an array');
        } if (!_.isObject(user) || !user.username) {
            throw new Error('user must be an object with username');
        }

        const username = user.username;

        // Strategy:
        // For each cluster node:
        //   (1) Gather roles that user has.
        //   (2) Determine differences
        //   (3) Apply changes.
        // 
        // Lots of ways for this to fail.
        //   (a) user doesn't exist on that node
        //   (b) role doesn't exist on that node
        //   (c) Underlying association query fails.
        const gatherRoles = (node) => {
            return node.run(ql.DBMS_SECURITY_USER_ROLES, { username })
                .then(results => neo4j.unpackResults(results, {
                    required: ['value'],
                }))
                // Pluck out only the role name to get to a simple array of strings
                // rather than array of objects.
                .then(results => results.map(r => r.value))
                .then(r => {
                    sentry.fine('gather roles made',r);
                    return r;
                });
        };

        const determineDifferences = (rolesHere, node) => {
            sentry.fine('determine differences', rolesHere, roles);
            const oldRoles = new Set(rolesHere);
            const newRoles = new Set(roles);
            const toDelete = new Set(
                [...oldRoles].filter(x => !newRoles.has(x))
            );
            const toAdd = new Set(
                [...newRoles].filter(x => !oldRoles.has(x))
            );
            // The roles they already have, which user wants to preserve (set intersection)
            const toPreserve = new Set(
                [...oldRoles].filter(x => newRoles.has(x))
            );
    
            sentry.fine('Determine differences',
                'rolesHere=',rolesHere, 'newRoles=', newRoles);
            sentry.fine('Role modification: ', 
                node.getBoltAddress(), 'adding', 
                [...toAdd], 
                'removing', [...toDelete], 
                'preserving', [...toPreserve]);
            return { 
                toAdd: [...toAdd], 
                toDelete: [...toDelete], 
                toPreserve: [...toPreserve],
            };
        };

        const applyChanges = (roleChanges, node) => {
            const { toAdd, toDelete } = roleChanges;

            const addPromises = [...toAdd].map(role => this.addNodeRole(node, username, role));
            const delPromises = [...toDelete].map(role => this.removeNodeRole(node, username, role));

            const allRolePromises = 
                addPromises.concat(delPromises);

            // TODO -- not wrapped in a TX.  It's possible for adding some roles to fail, others
            // to succeed.
            return Promise.all(allRolePromises)
                .then(() => {
                    const added = [...toAdd].join(', ');
                    const removed = [...toDelete].join(', ');

                    const addedStr = added ? 'Added: ' + added : '';
                    const removedStr = removed ? 'Removed: ' + removed : '';

                    const results = `Assigned roles to ${username}. ${addedStr} ${removedStr}`;
                    return clusterOpSuccess(node, results);
                })
                .catch(err => {
                    sentry.reportError(err, 'Cluster operation failure applying role changes');
                    return clusterOpFailure(node, err);
                });
        };

        const allPromises = this.ctx.members().map(node => {
            return gatherRoles(node)
                .then(rolesHere => determineDifferences(rolesHere, node))
                .then(roleChanges => applyChanges(roleChanges, node))
                .then(() => {
                    this.addEvent({
                        type: 'roleassoc',
                        message: `Associated "${username}" to roles ${roles.map(r => `"${r}"`).join(', ')}`,
                        payload: { username, roles },
                    });
                })
                .then(() => clusterOpSuccess(node))
                .catch(err => clusterOpFailure(node, err));
        });

        return Promise.all(allPromises)
            .then(packageClusterOpResults);
    }
}