import "dotenv/config";
import { Telegraf } from "telegraf";
import { message } from "telegraf/filters";

// assert and refuse to start bot if token is not passed
if (!process.env.BOT_TOKEN) throw new Error('"BOT_TOKEN" env var is required!');
if (!process.env.DEST_CHANNEL) throw new Error('"DEST_CHANNEL" env var is required!');

const destination = process.env.DEST_CHANNEL;
const bot = new Telegraf(process.env.BOT_TOKEN);

bot.start((ctx) => ctx.reply("Welcome~"));
bot.help((ctx) => ctx.reply("God help those who help themselves"));
bot.on(message("sticker"), (ctx) => ctx.reply("👍"));

bot.on(message, async (ctx) => {
	const echo = await ctx.reply(`Received, processing...`);

	let matchResponse, finishResponse, channel;

	const message = ctx.message;

	// in post link format
	const regex = /^https:\/\/t\.me\/[a-zA-Z0-9_]+\/\d+$/;
	if (regex.test(message.text)) {
		// response for channel match
		matchResponse = await ctx.reply(`It's a link from channel`);

		const match = message.text.match(/https:\/\/t\.me\/([a-zA-Z0-9_]+)\/(\d+)/);
		const channelId = '@' + match[1];
		const postId = match[2];
		channel = await ctx.telegram.getChat(channelId);

		try {
			await ctx.telegram.forwardMessage(destination, channelId, postId)
		} catch (e) {
			console.log('forward error');
			console.error(e);
		}
		if (channel) {
			finishResponse = await ctx.reply(`Channel :\n\nID: ${channel.id}\nTitle: ${channel.title}`);
		} else {
			finishResponse = await ctx.reply('can\'t get channel info');
		}
	} else {
		finishResponse = await ctx.reply('please check input');
	}

	// in post format todo


	await clearMessageBuffer(ctx, [echo, matchResponse, finishResponse]);
});

bot.launch();

// Enable graceful stop
process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));

/**
 * clear message buffer
 * @param {*} ctx 
 * @param {*} messageList 
 */
async function clearMessageBuffer(ctx, messageList) {
	for (let i = 0; i < messageList.length; i++) {
		if (messageList[i])
			await ctx.deleteMessage(messageList[i])
	}
}