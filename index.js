const { SettingProvider } = require('discord.js-commando');

/**
 * Uses an MongoDB collection to store settings with guilds
 * @extends {SettingProvider}
 */
class MongoDBProvider extends SettingProvider {

	/**
	 * @param {MongoClient} client - Database for the provider
	 * @param {string} dbName - The database name
	 */
	constructor(client, dbName) {
		super();

		/**
		 * Database that will be used for storing/retrieving settings
		 * @type {Db}
		 */
		this.db = client.db(dbName);

		/**
		 * Client that the provider is for (set once the client is ready, after using {@link CommandoClient#setProvider})
		 * @name SQLiteProvider#client
		 * @type {CommandoClient}
		 * @readonly
		 */
		Object.defineProperty(this, 'client', { value: null, writable: true });

		/**
		 * Settings cached in memory, mapped by guild ID (or 'global')
		 * @type {Map}
		 * @private
		 */
		this.settings = new Map();

		/**
		 * Listeners on the Client, mapped by the event name
		 * @type {Map}
		 * @private
		 */
		this.listeners = new Map();
	}

	async init(client) {
		this.client = client;
        
        // Load or create the settings collection
        const collection = await this.db.collection('settings');
        
        // Load all settings
        collection.find().forEach(doc => {
            const guild = doc.guild !== 0 ? doc.guild : 'global';
            this.settings.set(guild, doc.settings);

            // Guild is not global, and doesn't exist currently so lets skip it.
            if(guild !== 'global' && !client.guilds.has(doc.guild)) return;

            this.setupGuild(guild, doc.settings);
        });

		// Listen for changes
		this.listeners
			.set('commandPrefixChange', (guild, prefix) => this.set(guild, 'prefix', prefix))
			.set('commandStatusChange', (guild, command, enabled) => this.set(guild, `cmd-${command.name}`, enabled))
			.set('groupStatusChange', (guild, group, enabled) => this.set(guild, `grp-${group.id}`, enabled))
			.set('guildCreate', guild => {
				const settings = this.settings.get(guild.id);
				if(!settings) return;
				this.setupGuild(guild.id, settings);
			})
			.set('commandRegister', command => {
				for(const [guild, settings] of this.settings) {
					if(guild !== 'global' && !client.guilds.has(guild)) continue;
					this.setupGuildCommand(client.guilds.get(guild), command, settings);
				}
			})
			.set('groupRegister', group => {
				for(const [guild, settings] of this.settings) {
					if(guild !== 'global' && !client.guilds.has(guild)) continue;
					this.setupGuildGroup(client.guilds.get(guild), group, settings);
				}
			});
		for(const [event, listener] of this.listeners) client.on(event, listener);
	}

	async destroy() {
		// Close database connection
		this.db.close();

		// Remove all listeners from the client
		for(const [event, listener] of this.listeners) this.client.removeListener(event, listener);
		this.listeners.clear();
	}

	get(guild, key, defVal) {
		const settings = this.settings.get(this.constructor.getGuildID(guild));
		return settings ? typeof settings[key] !== 'undefined' ? settings[key] : defVal : defVal;
	}

	async set(guild, key, val) {
		guild = this.constructor.getGuildID(guild);
		let settings = this.settings.get(guild);
		if(!settings) {
			settings = {};
			this.settings.set(guild, settings);
		}

        settings[key] = val;
        
        await this.updateGuild(guild, settings);

		if(guild === 'global') this.updateOtherShards(key, val);
		return val;
	}

	async remove(guild, key) {
		guild = this.constructor.getGuildID(guild);
		const settings = this.settings.get(guild);
		if(!settings || typeof settings[key] === 'undefined') return;

		const val = settings[key];
        delete settings[key]; // NOTE: I know this isn't efficient, but it does the job.

        await this.updateGuild(guild, settings);

		if(guild === 'global') this.updateOtherShards(key, undefined);
		return val;
	}

	async clear(guild) {
		guild = this.constructor.getGuildID(guild);
		if(!this.settings.has(guild)) return;
        this.settings.delete(guild);
        
        const collection = await this.db.collection('settings');
        return collection.deleteOne({ guild: guild !== 'global' ? guild : 0 });
    }
    
    async updateGuild(guild, settings) {
        guild = guild !== 'global' ? guild : 0;

        const collection = await this.db.collection('settings');
        return collection.updateOne({ guild }, { $set: { guild, settings } }, { upsert: true });
    }

	/**
	 * Loads all settings for a guild
	 * @param {string} guild - Guild ID to load the settings of (or 'global')
	 * @param {Object} settings - Settings to load
	 * @private
	 */
	setupGuild(guild, settings) {
		if(typeof guild !== 'string') throw new TypeError('The guild must be a guild ID or "global".');
		guild = this.client.guilds.get(guild) || null;

		// Load the command prefix
		if(typeof settings.prefix !== 'undefined') {
			if(guild) guild._commandPrefix = settings.prefix;
			else this.client._commandPrefix = settings.prefix;
		}

		// Load all command/group statuses
		for(const command of this.client.registry.commands.values()) this.setupGuildCommand(guild, command, settings);
		for(const group of this.client.registry.groups.values()) this.setupGuildGroup(guild, group, settings);
	}

	/**
	 * Sets up a command's status in a guild from the guild's settings
	 * @param {?Guild} guild - Guild to set the status in
	 * @param {Command} command - Command to set the status of
	 * @param {Object} settings - Settings of the guild
	 * @private
	 */
	setupGuildCommand(guild, command, settings) {
		if(typeof settings[`cmd-${command.name}`] === 'undefined') return;
		if(guild) {
			if(!guild._commandsEnabled) guild._commandsEnabled = {};
			guild._commandsEnabled[command.name] = settings[`cmd-${command.name}`];
		} else {
			command._globalEnabled = settings[`cmd-${command.name}`];
		}
	}

	/**
	 * Sets up a group's status in a guild from the guild's settings
	 * @param {?Guild} guild - Guild to set the status in
	 * @param {CommandGroup} group - Group to set the status of
	 * @param {Object} settings - Settings of the guild
	 * @private
	 */
	setupGuildGroup(guild, group, settings) {
		if(typeof settings[`grp-${group.id}`] === 'undefined') return;
		if(guild) {
			if(!guild._groupsEnabled) guild._groupsEnabled = {};
			guild._groupsEnabled[group.id] = settings[`grp-${group.id}`];
		} else {
			group._globalEnabled = settings[`grp-${group.id}`];
		}
	}

	/**
	 * Updates a global setting on all other shards if using the {@link ShardingManager}.
	 * @param {string} key - Key of the setting to update
	 * @param {*} val - Value of the setting
	 * @private
	 */
	updateOtherShards(key, val) {
		if(!this.client.shard) return;
		key = JSON.stringify(key);
		val = typeof val !== 'undefined' ? JSON.stringify(val) : 'undefined';
		this.client.shard.broadcastEval(`
			if(this.shard.id !== ${this.client.shard.id} && this.provider && this.provider.settings) {
				let global = this.provider.settings.get('global');
				if(!global) {
					global = {};
					this.provider.settings.set('global', global);
				}
				global[${key}] = ${val};
			}
		`);
	}
}

module.exports = MongoDBProvider;
