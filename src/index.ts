
import { Client, Events, GatewayIntentBits, type VoiceBasedChannel, GuildMember, type MessageCreateOptions, EmbedType, ComponentType, type InteractionButtonComponentData, ButtonStyle, type MessageEditOptions, MessageFlags, VoiceState } from 'discord.js';

class UserState {
    // TODO: add persistent caching for display names, so we can update them on name changes and not lose them on restart
    displayName: string;
    private _raisedHand: number; // 0 for not raised, positive for position in queue

    constructor(private member: GuildMember) {
        this.displayName = member.displayName;
        this._raisedHand = 0;
    }

    get userId(): string {
        return this.member.id;
    }

    get raisedHand(): number {
        return this._raisedHand;
    }

    set raisedHand(position: number) {
        this._raisedHand = position;
        
        if (position === 0) {
            // Reset nickname when hand is lowered
            this.member.setNickname(this.displayName).catch(error => {
                console.error(`Error resetting nickname for user ${this.userId}:`, error);
            });
        } else {
            // Update nickname to show raised hand position
            const newNickname = `[✋ ${position} ] ${this.displayName}`;
            this.member.setNickname(newNickname).catch(error => {
                console.error(`Error setting nickname for user ${this.userId}:`, error);
            });
        }
    }
}

class VoiceChannelState {
    channelId: string;
    users: Map<string, UserState>;
    _messageHandler: MessageHandler | null;

    constructor(channelId: string, private bot: DiscordBot) {
        this.channelId = channelId;
        this.users = new Map();
        this._messageHandler = null;
    }

    get messageHandler(): MessageHandler {
        if (!this._messageHandler) {
            this._messageHandler = new MessageHandler(this, bot);
        }
        return this._messageHandler;
    }

    get tracking(): boolean {
        return this.users.size > 0;
    }

    addUser(user: UserState) {
        this.users.set(user.userId, user);
    }

    removeUser(userId: string) {
        // Lower hand first
        this.lowerHand(userId);
        this.users.delete(userId);

        // If there are no more users, we can stop tracking and delete the message
        if (!this.tracking) {
            this.messageHandler.deleteMessage();
        }
    }

    getUser(userId: string): UserState | undefined {
        return this.users.get(userId);
    }

    hasUser(userId: string): boolean {
        return this.users.has(userId);
    }

    raiseHand(userId: string) {
        const user = this.users.get(userId);
        if (!user) return;
        if (user.raisedHand === 0) {
            user.raisedHand = this.getMaxRaisedHand() + 1;
        }

        this.messageHandler.updateMessage(false);
    }

    lowerHand(userId: string) {
        const user = this.users.get(userId);

        if (!user) return;
        if (user.raisedHand === 0) return; // Hand is not raised

        let currentPosition = user.raisedHand;
        user.raisedHand = 0;

        // Update other users' raised hand positions
        for (const otherUser of this.users.values()) {
            if (otherUser.raisedHand > currentPosition) {
                otherUser.raisedHand -= 1;
            }
        }

        this.messageHandler.updateMessage(false);
    }

    getMaxRaisedHand(): number {
        let max = 0;
        for (const user of this.users.values()) {
            if (user.raisedHand > max) {
                max = user.raisedHand;
            }
        }
        return max;
    }

    printUsers() {
        // Order by raised hand position (0 at the end)
        const sortedUsers = Array.from(this.users.values()).sort((a, b) => {
            if (a.raisedHand === 0 && b.raisedHand === 0) return 0; // Both not raised
            if (a.raisedHand === 0) return 1; // a not raised, b raised
            if (b.raisedHand === 0) return -1; // a raised, b not raised
            return a.raisedHand - b.raisedHand; // Both raised, sort by position
        });
        for (const user of sortedUsers) {
            console.log(`  User: ${user.displayName} (${user.userId}), Raised Hand: ${user.raisedHand}`);
        }
    }
}

class VoiceChannelManager {
    channels: Map<string, VoiceChannelState>;

    constructor(private bot: DiscordBot) {
        this.channels = new Map();
    }

    hasChannel(channelId: string): boolean {
        return this.channels.has(channelId);
    }

    getOrCreateChannel(channelId: string): VoiceChannelState {
        let channel = this.channels.get(channelId);
        if (!channel) {
            channel = new VoiceChannelState(channelId, this.bot);
            this.channels.set(channelId, channel);
        }
        return channel;
    }

    removeUserFromChannel(channelId: string, userId: string) {
        const channel = this.channels.get(channelId);
        if (!channel) return;
        channel.removeUser(userId);
    }

    printState() {
        console.log('Current Voice Channel States:');
        for (const [channelId, channelState] of this.channels) {
            console.log(`Channel ID: ${channelId}, Tracking: ${channelState.tracking}`);
            channelState.printUsers();
        }
    }
}

class MessageHandler {
    channelState: VoiceChannelState;
    latestMessageId: string | null;

    constructor(channelState: VoiceChannelState, private bot: DiscordBot) {
        this.channelState = channelState;
        this.latestMessageId = null;
    }

    async updateMessage(shouldDeleteOld: boolean) {
        const channel = await this.bot.client.channels.fetch(this.channelState.channelId);
        if (!channel || !channel.isVoiceBased()) return;

        // We should delete the old message before sending a new one to avoid clutter
        if (shouldDeleteOld) {
            await this.deleteMessage();
        }

        // We need a message
        let message = null;
        if (this.latestMessageId) {
            try {
                message = await channel.messages.fetch(this.latestMessageId);
            } catch (error) {
                // Assume our message has been deleted by someone else, so we need to send a new one
                console.error('Error fetching existing message for update:', error);
                this.latestMessageId = null;
            }
        }

        const messageContent = {
            embeds: [
                {
                    type: EmbedType.Rich,
                    title: this.channelState.getMaxRaisedHand() > 0 ? 'Paceltās rokas' : 'Nav paceltu roku',
                    description: Array.from(this.channelState.users.values())
                        .filter(user => user.raisedHand > 0)
                        .sort((a, b) => a.raisedHand - b.raisedHand)
                        .map(user => `[✋ ${user.raisedHand} ] <@${user.userId}>`)
                        .join('\n') || undefined,
                    color: 0x5865F2, // Blurple
                }
            ],
            components: [
                {
                    type: ComponentType.ActionRow,
                    components: [
                        {
                            type: ComponentType.Button,
                            style: ButtonStyle.Success,
                            emoji: '✋',
                            label: 'Pacelt',
                            customId: 'raise_hand',
                        } satisfies InteractionButtonComponentData,
                        {
                            type: ComponentType.Button,
                            style: ButtonStyle.Danger,
                            emoji: '👇',
                            label: 'Nolaist',
                            customId: 'lower_hand',
                        } satisfies InteractionButtonComponentData,
                    ],
                }
            ],
            allowedMentions: { parse: [] }, // Disable @everyone and @here mentions
            nonce: Math.random().toString(36).substring(2, 15), // Unique nonce to prevent duplicate message issues (TODO: handle better)
            enforceNonce: true,
            tts: false,
            flags: [ MessageFlags.SuppressNotifications ],
        } satisfies MessageCreateOptions | MessageEditOptions;

        if (!message) {
            // If we don't have an existing message, we need to send a new one
            try {
                message = await channel.send(messageContent);
                this.latestMessageId = message.id;
            } catch (error) {
                console.error('Error sending initial message:', error);
                return;
            }
        } else {
            // We have an existing message, so we should edit it
            try {
                await message.edit({ ...messageContent, flags: [] }); // Clear flags on edit (notifications are not sent on edit, discord disallows this flag on edit)
            } catch (error) {
                console.error('Error editing existing message:', error);
            }
        }

    }

    async deleteMessage() {
        if (this.latestMessageId) {
            try {
                const channel = await this.bot.client.channels.fetch(this.channelState.channelId);
                if (!channel || !channel.isVoiceBased()) return;
                await channel.messages.delete(this.latestMessageId);
                this.latestMessageId = null;
            } catch (error) {
                console.error('Error deleting message:', error);
            }
        }
    }
}

class DiscordBot {
    client: Client;
    voiceChannelManagers: Map<string, VoiceChannelManager>; // guild -> manager

    constructor() {
        this.client = new Client({
            intents: [
                GatewayIntentBits.Guilds,
                GatewayIntentBits.GuildVoiceStates,
                GatewayIntentBits.GuildMessages,
                GatewayIntentBits.GuildMembers,
            ]
        });
        this.voiceChannelManagers = new Map();
        this.registerEvents();


        process.on('SIGINT', () => {
            const promises = [];
            console.log('Shutting down gracefully...');
            // Unregister all client events
            this.client.removeAllListeners();

            // Lower all hands, delete all messages before shutdown to avoid leaving orphaned messages in channels
            for (const [guildId, manager] of this.voiceChannelManagers) {
                for (const channelState of manager.channels.values()) {
                    for (const user of channelState.users.values()) {
                        // Reset all display names
                        const promise = this.client.guilds.fetch(guildId).then(guild => {
                            guild.members.fetch(user.userId).then(member => {
                                member.setNickname(user.displayName).catch(error => {
                                    console.error(`Error resetting nickname for user ${user.userId} in guild ${guildId}:`, error);
                                });
                            }).catch(error => {
                                console.error(`Error fetching member ${user.userId} in guild ${guildId}:`, error);
                            });
                        }).catch(error => {
                            console.error(`Error fetching guild ${guildId}:`, error);
                        });

                        promises.push(promise);
                    }
                    const promise = channelState.messageHandler.deleteMessage();
                    promises.push(promise);
                }
            }

            Promise.all(promises).then(() => {
                process.exit(0);
            }).catch(error => {
                console.error('Error occurred while shutting down:', error);
                process.exit(1);
            });
        });
    }

    getManager(guildId: string): VoiceChannelManager {
        let manager = this.voiceChannelManagers.get(guildId);
        if (!manager) {
            manager = new VoiceChannelManager(this);
            this.voiceChannelManagers.set(guildId, manager);
        }
        return manager;
    }

    registerEvents() {
        this.client.once(Events.ClientReady, () => {
            this.init();
        });

        this.client.on(Events.MessageCreate, async (message) => {
            if (message.author.bot) return; // Ignore bot messages

            if (!message.inGuild()) return;

            // If the message originates from a tracked voice channel, we need to pin the message
            if (this.getManager(message.guildId).hasChannel(message.channelId)) {
                const channelState = this.getManager(message.guildId).getOrCreateChannel(message.channelId); // Doesn't create :)
                if (channelState.tracking) {
                    await channelState.messageHandler.updateMessage(true);
                }
            }
        });

        this.client.on(Events.VoiceStateUpdate, async (oldState, newState) => {
            // Is this the first join for this channel? If so, we need to create a message for this channel
            if (!oldState.channelId && newState.channelId) {
                const channel = await this.client.channels.fetch(newState.channelId);
                if (!channel || !channel.isVoiceBased()) return; // Unreachable
                if (channel.members.size === 1) { // This is the first user joining, so we need to create a message for this channel
                    const channelState = this.getManager(newState.guild.id).getOrCreateChannel(newState.channelId);
                    if (!channelState.tracking) {
                        await channelState.messageHandler.updateMessage(true);
                    }
                }
            }

            await this.handleVoiceStateUpdate(oldState, newState);
        });

        // TODO: figure out a way to make this function correctly (ignore our own setNickname calls to prevent infinite loops, but still update on manual nickname changes)
        // this.client.on(Events.GuildMemberUpdate, (oldUser, newUser) => {
        //     // Update display name (ignore if this is our doing)
        //     if (oldUser.displayName !== newUser.displayName) {
        //         const guildId = newUser.guild.id;
        //         const userId = newUser.id;
        //         const manager = this.getManager(guildId);
        //         for (const channelState of manager.channels.values()) {
        //             const user = channelState.getUser(userId);
        //             if (user) {
        //                 user.displayName = newUser.displayName;
        //                 if (channelState.tracking) {
        //                     channelState.messageHandler.updateMessage(false);
        //                 }
        //             }
        //         }
        //     }
        // });

        this.client.on(Events.InteractionCreate, async (interaction) => {
            if (!interaction.isButton() || !interaction.inGuild()) return;

            const channelId = interaction.channelId;
            const userId = interaction.user.id;

            const channelState = this.getManager(interaction.guildId).getOrCreateChannel(channelId);
            if (!channelState.tracking) {
                await interaction.reply({ content: 'Šobrīd šajā balss kanālā nav neviena.', ephemeral: true });
                return;
            }

            if (interaction.customId === 'raise_hand') {
                channelState.raiseHand(userId);
                channelState.messageHandler.updateMessage(false);
                interaction.deferUpdate({ withResponse: false }); // Acknowledge the interaction without sending a message
            } else if (interaction.customId === 'lower_hand') {
                channelState.lowerHand(userId);
                channelState.messageHandler.updateMessage(false);
                interaction.deferUpdate({ withResponse: false }); // Acknowledge the interaction without sending a message
            }
        });
    }

    async handleVoiceStateUpdate(oldState: VoiceState, newState: VoiceState) {
        console.log(`Voice state update in channel ${newState.channelId} for user ${newState.id}`);

        // User joined a voice channel
        if (!oldState.channelId && newState.channelId) {
            console.log(`User ${newState.id} joined channel ${newState.channelId}`);
            const channelState = this.getManager(newState.guild.id).getOrCreateChannel(newState.channelId);
            const freshUserState = new UserState(newState.member ?? (await newState.guild.members.fetch(newState.id)));
            channelState.addUser(freshUserState);
        }

        // User left a voice channel
        if (oldState.channelId && !newState.channelId) {
            console.log(`User ${newState.id} left channel ${oldState.channelId}`);
            this.getManager(newState.guild.id).removeUserFromChannel(oldState.channelId, newState.id);
        }

        // User switched voice channels
        if (oldState.channelId && newState.channelId && oldState.channelId !== newState.channelId) {
            console.log(`User ${newState.id} switched from channel ${oldState.channelId} to ${newState.channelId}`);
            this.getManager(newState.guild.id).removeUserFromChannel(oldState.channelId, newState.id);
            const newChannelState = this.getManager(newState.guild.id).getOrCreateChannel(newState.channelId);
            const freshUserState = new UserState(newState.member ?? (await newState.guild.members.fetch(newState.id)));
            newChannelState.addUser(freshUserState);
        }

        if (process.env.NODE_ENV !== 'production') {
            this.getManager(newState.guild.id).printState();
        }
    }

    async init() {
        console.log('Initializing bot...');
        // Fetch all guilds and their voice channels to initialize tracking
        const guilds = await this.client.guilds.fetch();
        for (const [guildId, guild] of guilds) {
            const fullGuild = await guild.fetch();
            const voiceChannels = fullGuild.channels.cache.filter((c: any) => c.isVoiceBased());
            for (const [channelId, channel] of voiceChannels) {
                this.getManager(guildId).getOrCreateChannel(channelId);
            }

            // Remove dangling prefixes for members
            const members = await fullGuild.members.fetch();
            for (const [memberId, member] of members) {
                if (member.user.bot) continue; // Ignore bots
                const displayName = member.displayName;
                if (displayName.startsWith('[✋') && displayName.includes(']')) {
                    const originalName = displayName.substring(displayName.indexOf(']') + 2);
                    member.setNickname(originalName).catch(error => {
                        console.error(`Error resetting nickname for user ${memberId} in guild ${guildId}:`, error);
                    });
                }
            }
        }
        
        for (const manager of this.voiceChannelManagers.values()) {
            for (const [channelId, channelState] of manager.channels) {
                const channel = await this.client.channels.fetch(channelId) as VoiceBasedChannel;
                if (channel && channel.isVoiceBased()) {
                    const members = channel.members
                    for (const [memberId, member] of members) {
                        channelState.addUser(new UserState(member));
                    }
                }
            }
        }

        for (const manager of this.voiceChannelManagers.values()) {
            for (const channelState of manager.channels.values()) {
                if (channelState.tracking) {
                    channelState.messageHandler.updateMessage(true);
                    // TODO: add persistent caching for message IDs, so we don't lose all messages on restart
                }
            }
        }

        console.log('Bot initialized and ready!');
    }

    login(token: string) {
        this.client.login(token);
    }
}

// Instantiate and start the bot
const bot = new DiscordBot();
bot.login(process.env.DISCORD_TOKEN!);