import {
	Command,
	CommandDecorators,
	Logger,
	logger,
	Message,
	Middleware
} from '@yamdbf/core';
import { Guild, User } from 'discord.js';

import { IMClient } from '../client';
import {
	defaultMemberSettings,
	getMemberSettingsType,
	LogAction,
	members,
	memberSettings,
	MemberSettingsKey,
	sequelize
} from '../sequelize';
import { SettingsCache } from '../utils/SettingsCache';
import { CommandGroup, createEmbed, RP, sendEmbed } from '../utils/util';

const { expect, resolve } = Middleware;
const { using, localizable } = CommandDecorators;

// Used to resolve and expect the correct arguments depending on the config key
const checkArgsMiddleware = (func: typeof resolve | typeof expect) => {
	return async function(
		message: Message,
		[rp, ..._args]: [RP, string]
	): Promise<[Message, any[]]> {
		const args = _args as string[];

		const key = args[0];
		if (!key) {
			return [message, [rp]];
		}

		let dbKey: MemberSettingsKey = Object.keys(MemberSettingsKey).find(
			(k: any) => MemberSettingsKey[k].toLowerCase() === key.toLowerCase()
		) as MemberSettingsKey;
		if (!dbKey) {
			throw Error(rp.CMD_MEMBERCONFIG_KEY_NOT_FOUND({ key }));
		}

		const user = args[1];
		if (!user) {
			// We call func (resolve or expect) with the string keys, await
			// the response (which is '[message, args[]]') and unwrap the args
			// after the resource proxy
			return [
				message,
				// tslint:disable-next-line:no-invalid-this
				[rp, ...(await func('key: String').call(this, message, [dbKey]))[1]]
			];
		}

		const value = args[2];
		if (typeof value === 'undefined') {
			return [
				message,
				[
					rp,
					// tslint:disable-next-line:no-invalid-this
					...(await func('key: String, user: User').call(this, message, [
						dbKey,
						user
					]))[1]
				]
			];
		}

		const newArgs = ([dbKey, user] as any[]).concat(args.slice(2));

		if (value === 'default') {
			return [
				message,
				[
					rp,
					...(await func('key: String, user: User, ...value?: String').call(
						// tslint:disable-next-line:no-invalid-this
						this,
						message,
						newArgs
					))[1]
				]
			];
		}

		if (value === 'none' || value === 'empty' || value === 'null') {
			if (defaultMemberSettings[dbKey] !== null) {
				const prefix = (await SettingsCache.get(message.guild.id)).prefix;
				throw Error(rp.CMD_MEMBERCONFIG_KEY_CANT_CLEAR({ prefix, key: dbKey }));
			}
			return [
				message,
				[
					rp,
					...(await func('key: String, user: User, ...value?: String').call(
						// tslint:disable-next-line:no-invalid-this
						this,
						message,
						newArgs
					))[1]
				]
			];
		}

		const type = getMemberSettingsType(dbKey);
		return [
			message,
			[
				rp,
				...(await func(`key: String, user: User, ...value?: ${type}`).call(
					// tslint:disable-next-line:no-invalid-this
					this,
					message,
					newArgs
				))[1]
			]
		];
	};
};

export default class extends Command<IMClient> {
	@logger('Command') private readonly _logger: Logger;

	public constructor() {
		super({
			name: 'memberconfig',
			aliases: ['memconfig', 'memconf'],
			desc: 'Show and change the config of members of the server',
			usage: '<prefix>memconf @user (key) (value)',
			info:
				'`@user`:\n' +
				'The member that the setting is changed for.\n\n' +
				'`key`:\n' +
				'The config setting which you want to show/change.\n\n' +
				'`value`:\n' +
				'The new value of the setting.\n\n' +
				'Use without args to show all set configs and keys.\n',
			callerPermissions: ['ADMINISTRATOR', 'MANAGE_CHANNELS', 'MANAGE_ROLES'],
			group: CommandGroup.Admin,
			guildOnly: true
		});
	}

	@localizable
	@using(checkArgsMiddleware(resolve))
	@using(checkArgsMiddleware(expect))
	public async action(
		message: Message,
		[rp, key, user, rawValue]: [RP, MemberSettingsKey, User, any]
	): Promise<any> {
		this._logger.log(
			`${message.guild.name} (${message.author.username}): ${message.content}`
		);

		const prefix = (await SettingsCache.get(message.guild.id)).prefix;
		const embed = createEmbed(this.client);

		if (!key) {
			embed.setTitle(rp.CMD_MEMBERCONFIG_TITLE());
			embed.setDescription(rp.CMD_MEMBERCONFIG_TEXT({ prefix }));

			const keys = Object.keys(MemberSettingsKey);
			embed.addField(rp.CMD_MEMBERCONFIG_KEYS_TITLE(), keys.join('\n'));

			await sendEmbed(message.channel, embed, message.author);
			return;
		}

		if (!user) {
			const allSets = await memberSettings.findAll({
				attributes: [
					'id',
					'key',
					'value',
					[sequelize.literal('`member`.`name`'), 'memberName']
				],
				where: {
					guildId: message.guild.id,
					key
				},
				include: [
					{
						attributes: [],
						model: members
					}
				],
				raw: true
			});
			if (allSets.length > 0) {
				allSets.forEach((set: any) =>
					embed.addField(set.memberName, set.value)
				);
			} else {
				embed.setDescription(rp.CMD_MEMBERCONFIG_NOT_SET_ANY_TEXT());
			}
			await sendEmbed(message.channel, embed, message.author);
			return;
		}

		const username = user.username;
		const oldSet = await memberSettings.find({
			where: {
				guildId: message.guild.id,
				memberId: user.id,
				key
			},
			raw: true
		});

		let oldVal = oldSet ? oldSet.value : undefined;
		let oldRawVal = this.fromDbValue(key, oldVal);
		if (oldRawVal && oldRawVal.length > 1000) {
			oldRawVal = oldRawVal.substr(0, 1000) + '...';
		}

		embed.setTitle(key);

		if (typeof rawValue === typeof undefined) {
			// If we have no new value, just print the old one
			// Check if the old one is set
			if (oldVal) {
				const clear = defaultMemberSettings[key] === null ? 't' : undefined;
				embed.setDescription(
					rp.CMD_MEMBERCONFIG_CURRENT_SET_TEXT({
						prefix,
						key,
						username,
						clear
					})
				);
				embed.addField(rp.CMD_MEMBERCONFIG_CURRENT_TITLE(), oldRawVal);
			} else {
				embed.setDescription(
					rp.CMD_MEMBERCONFIG_CURRENT_NOT_SET_TEXT({ prefix })
				);
			}
			await sendEmbed(message.channel, embed, message.author);
			return;
		}

		const parsedValue = this.toDbValue(message.guild, key, rawValue);
		if (parsedValue.error) {
			message.channel.send(parsedValue.error);
			return;
		}

		const value = parsedValue.value;
		if (rawValue.length > 1000) {
			rawValue = rawValue.substr(0, 1000) + '...';
		}

		if (value === oldVal) {
			embed.setDescription(rp.CMD_MEMBERCONFIG_ALREADY_SET_SAME_VALUE());
			embed.addField(rp.CMD_MEMBERCONFIG_CURRENT_TITLE(), rawValue);
			await sendEmbed(message.channel, embed, message.author);
			return;
		}

		const error = this.validate(message, key, value);
		if (error) {
			message.channel.send(error);
			return;
		}

		await memberSettings.insertOrUpdate({
			id: null,
			guildId: message.guild.id,
			memberId: user.id,
			key,
			value
		});

		embed.setDescription(rp.CMD_MEMBERCONFIG_CHANGED_TEXT({ prefix }));

		// Log the settings change
		this.client.logAction(message, LogAction.memberConfig, {
			key,
			userId: user.id,
			oldValue: oldVal,
			newValue: value
		});

		if (oldVal) {
			embed.addField(rp.CMD_MEMBERCONFIG_PREVIOUS_TITLE(), oldRawVal);
		}

		embed.addField(
			rp.CMD_MEMBERCONFIG_NEW_TITLE(),
			value ? rawValue : rp.CMD_MEMBERCONFIG_NONE()
		);
		oldVal = value; // Update value for future use

		await sendEmbed(message.channel, embed, message.author);
	}

	// Convert a raw value into something we can save in the database
	private toDbValue(
		guild: Guild,
		key: MemberSettingsKey,
		value: any
	): { value?: string; error?: string } {
		if (value === 'default') {
			return { value: defaultMemberSettings[key] };
		}
		if (value === 'none' || value === 'empty' || value === 'null') {
			return { value: null };
		}

		const type = getMemberSettingsType(key);
		if (type === 'Boolean') {
			return { value: value ? 'true' : 'false' };
		}

		return { value };
	}

	// Convert a DB value into a human readable value
	private fromDbValue(key: MemberSettingsKey, value: string): string {
		if (value === undefined || value === null) {
			return value;
		}

		/*const type = getMemberSettingsType(key);
		if (type === 'Channel') {
			return `<#${value}>`;
		}*/

		return value;
	}

	// Validate a new config value to see if it's ok (no parsing, already done beforehand)
	private validate(
		message: Message,
		key: MemberSettingsKey,
		value: any
	): string | null {
		if (value === null || value === undefined) {
			return null;
		}

		/*const type = getMemberSettingsType(key);*/

		return null;
	}
}
