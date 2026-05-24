import "dotenv/config";
import { TelegramClient, Api, sessions } from "telegram";
import prompts from "prompts";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import fs from "node:fs";
import path from "node:path";

const { StringSession } = sessions;

// 终端颜色定义
const colors = {
	reset: "\x1b[0m",
	bright: "\x1b[1m",
	green: "\x1b[32m",
	yellow: "\x1b[33m",
	blue: "\x1b[34m",
	red: "\x1b[31m",
	cyan: "\x1b[36m",
	gray: "\x1b[90m"
};

function logInfo(msg) {
	console.log(`${colors.blue}[信息]${colors.reset} ${msg}`);
}

function logSuccess(msg) {
	console.log(`${colors.green}[成功]${colors.reset} ${msg}`);
}

function logWarn(msg) {
	console.log(`${colors.yellow}[警告]${colors.reset} ${msg}`);
}

function logError(msg) {
	console.log(`${colors.red}[错误]${colors.reset} ${msg}`);
}

/**
 * 清除终端历史行
 */
function clearPreviousLines(numLines) {
	for (let i = 0; i < numLines; i++) {
		process.stdout.write("\x1B[1A\x1B[2K");
	}
}

// 1. 读取本地配置文件 forward-config.json并初始化默认值
const CONFIG_FILE = path.join(process.cwd(), "forward-config.json");
let config = {
	filters: {
		text: { excludeRegex: "", includeRegex: "" },
		mediaTypes: {
			allowTextOnly: true,
			allowPhoto: true,
			allowVideo: true,
			allowDocument: true,
			allowSticker: true,
			allowAnimation: true,
			allowAudio: true,
			allowVoice: true
		}
	},
	settings: {
		destinations: [],
		maxConsecutiveFailures: 30,
		delayMs: 1500,
		showSenderNames: true,
		jitterRange: [0.95, 1.45],
		comments: {
			enabled: false,
			mode: "media"
		}
	}
};

if (fs.existsSync(CONFIG_FILE)) {
	try {
		const parsedConfig = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8"));
		// 进行简单的深度合并，保证配置文件中缺少某些字段时能正确读取到最头部的默认配置
		config.filters.text = { ...config.filters.text, ...parsedConfig.filters?.text };
		config.filters.mediaTypes = { ...config.filters.mediaTypes, ...parsedConfig.filters?.mediaTypes };
		config.settings = { ...config.settings, ...parsedConfig.settings };
		if (parsedConfig.settings?.comments) {
			config.settings.comments = { ...config.settings.comments, ...parsedConfig.settings.comments };
		}
		logInfo("成功加载本地配置文件 forward-config.json");
	} catch (err) {
		logError(`解析 forward-config.json 配置文件失败: ${err.message}，将使用内置默认配置。`);
	}
} else {
	logWarn("未找到配置文件 forward-config.json，将使用内置默认配置。");
}

// 检查环境变量
const API_ID = process.env.API_ID ? parseInt(process.env.API_ID, 10) : null;
const API_HASH = process.env.API_HASH;

if (!API_ID || isNaN(API_ID)) {
	logError("环境变量 API_ID 未设置或格式错误！请检查 .env 文件。");
	process.exit(1);
}
if (!API_HASH) {
	logError("环境变量 API_HASH 未设置！请检查 .env 文件。");
	process.exit(1);
}

// 检查配置文件与环境变量中的目标频道并进行合并去重
let rawDestinations = [];

// 1. 从配置文件加载
if (config.settings && Array.isArray(config.settings.destinations)) {
	rawDestinations = [...config.settings.destinations];
}

// 2. 从环境变量加载 (支持英文逗号分隔的多个频道)
if (process.env.DEST_CHANNEL) {
	const envDests = process.env.DEST_CHANNEL.split(",")
		.map(d => d.trim())
		.filter(d => d.length > 0);
	rawDestinations = [...rawDestinations, ...envDests];
}

// 3. 合并去重
const DESTINATIONS = [...new Set(rawDestinations)];

if (DESTINATIONS.length === 0) {
	logError("未在配置文件 forward-config.json 中找到 destinations，也未在 .env 中设置 DEST_CHANNEL 环境变量！请至少配置其中之一。");
	process.exit(1);
}

// 解析代理配置 (GramJS 原生仅支持 Socks5 代理)
let proxyOptions = undefined;
if (process.env.TELEGRAM_PROXY) {
	try {
		const url = new URL(process.env.TELEGRAM_PROXY);
		const ip = url.hostname;
		const port = parseInt(url.port, 10);
		
		logInfo(`已配置 Socks5 代理: ${colors.bright}${ip}:${port}${colors.reset}`);
		proxyOptions = {
			ip: ip,
			port: port,
			socksType: 5,
			timeout: 5
		};
	} catch (e) {
		logWarn("无法自动解析 TELEGRAM_PROXY 代理，将尝试直连。请确认代理格式为: socks5://127.0.0.1:7890");
	}
} else {
	logWarn("未检测到代理环境。如连接超时，请在 .env 中设置 TELEGRAM_PROXY=socks5://127.0.0.1:7890");
}

/**
 * 解析 Telegram 消息链接
 */
function parseTelegramLink(link) {
	const cleanLink = link.trim();

	// 1. 私有频道格式: https://t.me/c/123456789/101
	const privateMatch = cleanLink.match(/https?:\/\/t\.me\/c\/(\d+)\/(\d+)/);
	if (privateMatch) {
		return {
			chatId: `-100${privateMatch[1]}`,
			messageId: parseInt(privateMatch[2], 10)
		};
	}

	// 2. 公开频道格式: https://t.me/channel_username/101
	const publicMatch = cleanLink.match(/https?:\/\/t\.me\/([a-zA-Z0-9_]+)\/(\d+)/);
	if (publicMatch) {
		return {
			chatId: `@${publicMatch[1]}`,
			messageId: parseInt(publicMatch[2], 10)
		};
	}

	return null;
}

/**
 * 获取友好的消息类型描述 (用于日志输出)
 */
function getMessageTypeDescription(msg) {
	if (!msg.media) return "纯文本";
	const className = msg.media.className;
	if (className === "MessageMediaPhoto") return "图片";
	if (className === "MessageMediaDocument") {
		const mime = msg.media.document?.mimeType || "";
		if (mime.includes("image/webp")) return "贴纸";
		if (mime.includes("image/gif")) return "GIF动图";
		if (mime.startsWith("video/")) return "视频";
		if (mime.startsWith("audio/")) return "音频";
		return "文件";
	}
	return "媒体";
}

/**
 * 判断单条消息是否满足过滤配置
 */
function shouldForwardMessage(msg) {
	// 1. 文本过滤
	const msgText = msg.message || "";
	const textFilters = config.filters?.text;
	
	if (textFilters) {
		if (textFilters.excludeRegex) {
			try {
				const excludeReg = new RegExp(textFilters.excludeRegex, "i");
				if (excludeReg.test(msgText)) {
					return { shouldForward: false, reason: `文本匹配到排除正则: "${textFilters.excludeRegex}"` };
				}
			} catch (e) {
				logError(`无效的排除正则表达式: ${textFilters.excludeRegex}`);
			}
		}
		if (textFilters.includeRegex) {
			try {
				const includeReg = new RegExp(textFilters.includeRegex, "i");
				if (!includeReg.test(msgText)) {
					return { shouldForward: false, reason: `文本未匹配到包含正则: "${textFilters.includeRegex}"` };
				}
			} catch (e) {
				logError(`无效的包含正则表达式: ${textFilters.includeRegex}`);
			}
		}
	}

	// 2. 媒体类型过滤
	const mediaTypes = config.filters?.mediaTypes;
	if (mediaTypes) {
		const media = msg.media;
		if (!media) {
			// 纯文本
			if (!mediaTypes.allowTextOnly) {
				return { shouldForward: false, reason: "配置禁用了纯文本消息 (allowTextOnly: false)" };
			}
		} else {
			const className = media.className;
			
			// 判断具体媒体子类型
			if (className === "MessageMediaPhoto") {
				if (!mediaTypes.allowPhoto) {
					return { shouldForward: false, reason: "配置禁用了图片消息 (allowPhoto: false)" };
				}
			} else if (className === "MessageMediaDocument") {
				const document = media.document;
				const mimeType = document?.mimeType || "";
				
				// 辅助检测属性
				let isSticker = false;
				let isGif = false;
				let isVideo = false;
				let isAudio = false;
				let isVoice = false;

				if (mimeType.includes("image/webp")) {
					isSticker = true;
				}
				if (mimeType.includes("image/gif")) {
					isGif = true;
				}
				if (mimeType.startsWith("video/")) {
					isVideo = true;
				}
				if (mimeType.startsWith("audio/")) {
					isAudio = true;
				}

				// 检查文档属性以获得更精确的分类
				if (document && document.attributes) {
					for (const attr of document.attributes) {
						if (attr.className === "DocumentAttributeAnimated") {
							isGif = true;
						}
						if (attr.className === "DocumentAttributeSticker") {
							isSticker = true;
						}
						if (attr.className === "DocumentAttributeVideo") {
							isVideo = true;
						}
						if (attr.className === "DocumentAttributeAudio") {
							if (attr.voice) {
								isVoice = true;
							} else {
								isAudio = true;
							}
						}
					}
				}

				if (isSticker && !mediaTypes.allowSticker) {
					return { shouldForward: false, reason: "配置禁用了表情贴纸消息 (allowSticker: false)" };
				}
				if (isGif && !mediaTypes.allowAnimation) {
					return { shouldForward: false, reason: "配置禁用了动图/GIF消息 (allowAnimation: false)" };
				}
				if (isVideo && !isGif && !mediaTypes.allowVideo) {
					return { shouldForward: false, reason: "配置禁用了视频消息 (allowVideo: false)" };
				}
				if (isVoice && !mediaTypes.allowVoice) {
					return { shouldForward: false, reason: "配置禁用了语音消息 (allowVoice: false)" };
				}
				if (isAudio && !isVoice && !mediaTypes.allowAudio) {
					return { shouldForward: false, reason: "配置禁用了音频消息 (allowAudio: false)" };
				}
				
				// 排除上述特定类型后的普通文件
				const isOtherDoc = !isSticker && !isGif && !isVideo && !isVoice && !isAudio;
				if (isOtherDoc && !mediaTypes.allowDocument) {
					return { shouldForward: false, reason: "配置禁用了普通文档/文件消息 (allowDocument: false)" };
				}
			} else {
				// 其他多媒体类型，比如地理位置、联系人卡片等
				if (!mediaTypes.allowDocument) {
					return { shouldForward: false, reason: "配置禁用了非文件类其他媒体消息 (allowDocument: false)" };
				}
			}
		}
	}

	return { shouldForward: true };
}

/**
 * 获取并转发指定频道消息关联的评论区消息（需源频道有关联讨论群）
 * @returns {Promise<number>} 成功转发的评论数量
 */
async function forwardComments(msg, sourceEntity, destEntities, dropAuthor, clientInstance) {
	const commentsConfig = config.settings?.comments ?? {};
	if (!commentsConfig.enabled) {
		return 0;
	}

	// 兼容 GramJS 驼峰和下划线的字段解析
	const repliesPeerId = msg.replies?.repliesPeerId || msg.replies?.replies_peer_id;
	const repliesId = msg.replies?.repliesId || msg.replies?.replies_id;

	if (!msg.replies || !repliesPeerId || !repliesId) {
		return 0;
	}

	const threadRootMsgId = repliesId;
	const mode = commentsConfig.mode || "all";

	// 1. 定位讨论群实体
	let discussionPeer;
	try {
		discussionPeer = await clientInstance.getEntity(repliesPeerId);
	} catch (err) {
		logWarn(`无法解析讨论群实体: ${err.message}，跳过评论区转发。`);
		return 0;
	}

	// 2. 通过 messages.GetReplies 拉取评论区消息
	let commentsResult;
	try {
		commentsResult = await clientInstance.invoke(new Api.messages.GetReplies({
			peer: discussionPeer,
			msgId: threadRootMsgId,
			offsetId: 0,
			offsetDate: 0,
			addOffset: 0,
			limit: 100,
			maxId: 0,
			minId: 0,
			hash: 0n
		}));
	} catch (err) {
		logWarn(`获取评论区消息失败: ${err.message}，跳过评论区转发。`);
		return 0;
	}

	// 3. 过滤掉讨论组根消息和空消息
	let allComments = commentsResult.messages.filter(m =>
		m.id !== threadRootMsgId && m.className !== "MessageEmpty"
	);

	if (allComments.length === 0) {
		return 0;
	}

	// 4. 按 mode 过滤: "media" → 仅转发含媒体的评论
	let commentsToForward;
	if (mode === "media") {
		commentsToForward = allComments.filter(m => {
			// 使用最健壮的高阶 Getter 进行媒体类型判断
			if (m.photo || m.video || m.audio || m.voice) return true;
			if (m.document) {
				const mime = m.document.mimeType || "";
				if (mime.includes("image/webp")) return false; // 过滤贴纸
				return true;
			}
			return false;
		});
	} else {
		commentsToForward = [...allComments];
	}

	if (commentsToForward.length === 0) {
		return 0;
	}

	const modeLabel = mode === "media" ? "仅媒体" : "全部";
	logInfo(`正在转发 ${commentsToForward.length} 条评论区消息 (${modeLabel})...`);

	for (const comment of commentsToForward) {
		for (const destEntity of destEntities) {
			try {
				await clientInstance.forwardMessages(destEntity, {
					messages: [comment.id],
					fromPeer: discussionPeer,
					dropAuthor: dropAuthor
				});
			} catch (err) {
				logWarn(`转发评论 #${comment.id} 失败: ${err.message}`);
			}
		}
		await new Promise(resolve => setTimeout(resolve, 500));
	}

	logSuccess(`成功附带转发 ${commentsToForward.length} 条评论区消息 ✓`);
	return commentsToForward.length;
}

async function main() {
	console.log(`${colors.bright}${colors.cyan}=========================================`);
	console.log("   Telegram 消息自动转发工具 (用户身份版)   ");
	console.log(`=========================================${colors.reset}\n`);

	logInfo(`当前配置:`);
	logInfo(`目标频道数量: ${colors.bright}${DESTINATIONS.length}${colors.reset} -> ${colors.gray}[${DESTINATIONS.join(", ")}]${colors.reset}`);

	// 1. 确保 .sessions 目录存在并获取已登录账号
	const SESSIONS_DIR = path.join(process.cwd(), ".sessions");
	if (!fs.existsSync(SESSIONS_DIR)) {
		fs.mkdirSync(SESSIONS_DIR, { recursive: true });
	}

	const sessionFiles = fs.readdirSync(SESSIONS_DIR).filter(file => file.endsWith(".session"));
	const BOT_TOKEN = process.env.BOT_TOKEN;
	
	let selectedSessionFile = "";
	let savedSession = "";
	let phoneNumber = "";
	let isBotMode = false;

	// 生成 TUI 登录选择菜单
	const identityChoices = [];
	if (sessionFiles.length > 0) {
		sessionFiles.forEach((file) => {
			const accName = file.replace(".session", "");
			let titleStr = accName;
			
			const nameFilePath = path.join(SESSIONS_DIR, file.replace(".session", ".name"));
			if (fs.existsSync(nameFilePath)) {
				const savedName = fs.readFileSync(nameFilePath, "utf-8").trim();
				titleStr = `${savedName} (手机: ${accName})`;
			}
			identityChoices.push({ title: `👤 用户账号: ${titleStr}`, value: { type: "existing", file } });
		});
	}

	if (BOT_TOKEN) {
		const botId = BOT_TOKEN.split(":")[0];
		const botNameFilePath = path.join(SESSIONS_DIR, `bot_${botId}.name`);
		let botTitle = `Bot 账号 (令牌 ID: ${botId})`;
		if (fs.existsSync(botNameFilePath)) {
			const savedBotName = fs.readFileSync(botNameFilePath, "utf-8").trim();
			botTitle = `${savedBotName} (Bot ID: ${botId})`;
		}
		identityChoices.push({ title: `👑 [Bot 身份] ${botTitle}`, value: { type: "bot" } });
	}

	identityChoices.push({ title: `[+] 登录全新用户账号`, value: { type: "new" } });

	const identityAns = await prompts({
		type: "select",
		name: "identity",
		message: "请选择执行身份:",
		choices: identityChoices
	});

	if (!identityAns.identity) {
		logWarn("操作已取消。");
		process.exit(0);
	}

	const choiceType = identityAns.identity.type;
	if (choiceType === "new") {
		const numAns = await prompts({
			type: "text",
			name: "phone",
			message: "请输入你要登录的手机号 (带国家码，如 +86138xxxxxxxx):",
			validate: val => !val.trim() ? "手机号不能为空！" : true
		});
		phoneNumber = numAns.phone.trim();
		selectedSessionFile = path.join(SESSIONS_DIR, `${phoneNumber}.session`);
	} else if (choiceType === "bot") {
		isBotMode = true;
		selectedSessionFile = path.join(SESSIONS_DIR, `bot_${BOT_TOKEN.split(":")[0]}.session`);
		if (fs.existsSync(selectedSessionFile)) {
			savedSession = fs.readFileSync(selectedSessionFile, "utf-8").trim();
		}
	} else {
		const file = identityAns.identity.file;
		phoneNumber = file.replace(".session", "");
		selectedSessionFile = path.join(SESSIONS_DIR, file);
		savedSession = fs.readFileSync(selectedSessionFile, "utf-8").trim();
	}

	// 优化终端输出：清除身份选择产生的 TUI 提问，保持界面极其干净
	clearPreviousLines(sessionFiles.length + (BOT_TOKEN ? 1 : 0) + 3);
	if (isBotMode) {
		logSuccess(`已选择身份: ${colors.bright}[Bot 机器人]${colors.reset}`);
	} else {
		logSuccess(`已选择身份: 用户账号 ${colors.bright}${phoneNumber}${colors.reset}`);
	}

	const stringSession = new StringSession(savedSession);
	const client = new TelegramClient(stringSession, API_ID, API_HASH, {
		connectionRetries: 5,
		useWSS: false,
		proxy: proxyOptions
	});

	// 2. 登录认证
	try {
		if (isBotMode) {
			await client.start({
				botAuthToken: BOT_TOKEN,
				onError: (err) => logError(`Bot 登录异常: ${err.message}`)
			});
			clearPreviousLines(1); // 擦除连接等过渡行
			logSuccess("🎉 Bot 身份连接登录成功！");
		} else {
			await client.start({
				phoneNumber: async () => phoneNumber,
				password: async () => {
					const ans = await prompts({
						type: "password",
						name: "pass",
						message: "请输入你的两步验证密码 (若未开启请直接按回车):"
					});
					return ans.pass;
				},
				phoneCode: async () => {
					const ans = await prompts({
						type: "text",
						name: "code",
						message: "请输入收到的 Telegram 登录验证码:"
					});
					return ans.code;
				},
				onError: (err) => logError(`登录异常: ${err.message}`)
			});
			clearPreviousLines(1); // 清理过渡行
			logSuccess(`🎉 用户账号 ${phoneNumber} 连接登录成功！`);
		}
		
		// 保存 Session
		const currentSession = client.session.save();
		fs.writeFileSync(selectedSessionFile, currentSession, "utf-8");

		// 获取并保存当前登录身份的昵称，用于主菜单展示
		try {
			const me = await client.getMe();
			const nameStr = me.className === "User" 
				? `${me.firstName || ""} ${me.lastName || ""}`.trim() + (me.username ? ` (@${me.username})` : "")
				: `${me.firstName || ""}`.trim() + (me.username ? ` (@${me.username})` : "");
			fs.writeFileSync(selectedSessionFile.replace(".session", ".name"), nameStr, "utf-8");
			logSuccess(`当前连接昵称: ${colors.bright}${nameStr}${colors.reset}\n`);
		} catch (meErr) {
			logWarn(`无法拉取当前身份昵称: ${meErr.message}`);
		}
	} catch (loginError) {
		logError(`登录/连接失败: ${loginError.message}`);
		process.exit(1);
	}

	// 2.5 获取并加载所有可用的目标频道实体信息
	logInfo("正在拉取已配制目标频道的名称与状态以生成选择菜单...");
	const resolvedDestinations = [];
	for (const dest of DESTINATIONS) {
		try {
			const entity = await client.getEntity(dest);
			resolvedDestinations.push({
				address: dest,
				title: entity.title || entity.username || dest,
				entity: entity
			});
		} catch (err) {
			logWarn(`无法连接到目标频道 [${dest}]，已从本次菜单中临时剔除。原因: ${err.message}`);
		}
	}

	if (resolvedDestinations.length === 0) {
		logError("错误：配置文件中所配制的目标频道均无法访问，请检查 forward-config.json！");
		process.exit(1);
	}

	// 清理拉取过程产生的日志提示
	clearPreviousLines(resolvedDestinations.length + 1);

	let activeDestEntities = [];
	if (resolvedDestinations.length === 1) {
		activeDestEntities = [resolvedDestinations[0].entity];
		logSuccess(`目标频道: ${colors.bright}${resolvedDestinations[0].title}${colors.reset} (${resolvedDestinations[0].address})`);
	} else {
		// 生成 TUI 目标频道多选菜单
		const destChoices = resolvedDestinations.map((destObj) => {
			return { title: `${destObj.title} (${destObj.address})`, value: destObj, selected: true };
		});
		destChoices.push({ title: `${colors.green}[全部同时发送]${colors.reset}`, value: "all" });

		const destAns = await prompts({
			type: "multiselect",
			name: "dests",
			message: "请选择本次要转发的目标频道 (使用空格键勾选/取消，回车确认):",
			choices: destChoices,
			hint: "- 空格键勾选，回车确认"
		});

		if (!destAns.dests || destAns.dests.length === 0) {
			logError("操作取消：未选择任何目标频道！");
			process.exit(0);
		}

		let finalSelected = [];
		if (destAns.dests.includes("all")) {
			finalSelected = [...resolvedDestinations];
		} else {
			finalSelected = destAns.dests;
		}

		activeDestEntities = finalSelected.map(d => d.entity);
		const chosenTitles = finalSelected.map(d => d.title);

		// 清理选择菜单，使终端展示非常完美
		clearPreviousLines(resolvedDestinations.length + 3);
		logSuccess(`已选目标频道: [${colors.bright}${chosenTitles.join(", ")}${colors.reset}]`);
	}

	// 3. 获取并解析消息链接（起始 & 结束）
	let parsed = null;
	while (!parsed) {
		const startAns = await prompts({
			type: "text",
			name: "link",
			message: "请输入【起始】消息链接 (从它的下一条消息开始转发):",
			validate: val => !val.trim() ? "起始消息链接不能为空！" : true
		});
		
		if (!startAns.link) {
			logWarn("操作已取消。");
			process.exit(0);
		}

		parsed = parseTelegramLink(startAns.link);
		if (!parsed) {
			logError("无法解析该链接，请重新输入正确的 Telegram 消息链接！\n");
		}
	}

	let endParsed = null;
	while (true) {
		const endAns = await prompts({
			type: "text",
			name: "link",
			message: "请输入【结束】消息链接 (可选，留空代表一直转发到最新可用消息):"
		});

		if (endAns.link === undefined) {
			logWarn("操作已取消。");
			process.exit(0);
		}

		const endLinkInput = endAns.link.trim();
		if (!endLinkInput) {
			break; // 用户留空，执行到最新消息
		}

		endParsed = parseTelegramLink(endLinkInput);
		if (!endParsed) {
			logError("无法解析该结束链接，请重新输入或直接按回车留空。\n");
			continue;
		}

		if (endParsed.chatId !== parsed.chatId) {
			logError("错误：结束消息所在的频道与起始消息所在的频道不一致，请重新输入！\n");
			endParsed = null;
			continue;
		}

		if (endParsed.messageId <= parsed.messageId) {
			logError(`错误：结束消息 ID (${endParsed.messageId}) 必须大于起始消息 ID (${parsed.messageId})，请重新输入！\n`);
			endParsed = null;
			continue;
		}

		break;
	}

	// 擦除链接提问产生的交互行
	clearPreviousLines(endParsed ? 4 : 3);
	logSuccess(`成功解析区间: 起始消息 ID #${parsed.messageId}` + (endParsed ? ` => 结束消息 ID #${endParsed.messageId}` : " => 最新消息"));

	// 4. 解析并验证源频道可见性与访问权限
	let sourceEntity = null;
	const destEntities = [...activeDestEntities]; // 直接复用之前已验证的目标实体

	try {
		sourceEntity = await client.getEntity(parsed.chatId);
	} catch (err) {
		logError(`无法访问源频道！错误: ${err.message}`);
		logError("请确保你的个人账号已经加入/关注了该频道。");
		process.exit(1);
	}

	// 5. 动态获取频道的最新一条消息 ID
	let latestId = null;
	try {
		const latestMessages = await client.getMessages(sourceEntity, { limit: 1 });
		if (latestMessages && latestMessages.length > 0) {
			latestId = latestMessages[0].id;
		}
	} catch (err) {
		// 获取最新 ID 报错静默，主要使用空消息判定退去即可
	}

	// 设定终点
	const targetEndId = endParsed ? endParsed.messageId : latestId;
	const sourceTitle = sourceEntity.title || sourceEntity.username || parsed.chatId;
	if (targetEndId) {
		logInfo(`任务范围: 从频道 【${colors.bright}${sourceTitle}${colors.reset}】 的消息 #${colors.bright}${parsed.messageId + 1}${colors.reset} 遍历转发至 #${colors.bright}${targetEndId}${colors.reset}\n`);
	} else {
		logInfo(`任务范围: 从频道 【${colors.bright}${sourceTitle}${colors.reset}】 的消息 #${colors.bright}${parsed.messageId + 1}${colors.reset} 转发至最新消息，连续空消息触发上限时自动停止。\n`);
	}

	// 6. 运行参数与过滤规则配置 (读取自已加载了默认值的 config 对象)
	let maxConsecutiveFailures = config.settings.maxConsecutiveFailures;
	let delayMs = config.settings.delayMs;
	let showSenderNames = config.settings.showSenderNames;
	let jitterMin = config.settings.jitterRange[0];
	let jitterMax = config.settings.jitterRange[1];
	let commentsCfg = config.settings.comments || { enabled: false, mode: "media" };

	const useDefaultAns = await prompts({
		type: "confirm",
		name: "useDefault",
		message: "是否使用配置文件中的所有默认运行与过滤设置？",
		initial: true
	});

	if (useDefaultAns.useDefault === undefined) {
		logWarn("操作已取消。");
		process.exit(0);
	}

	if (!useDefaultAns.useDefault) {
		// A. 通过多选菜单选择需要自定义的板块
		const editSectionsAns = await prompts({
			type: "multiselect",
			name: "sections",
			message: "请勾选你需要临时自定义修改的配置板块 (空格键勾选，回车确认):",
			choices: [
				{ title: "运行速率与参数 (延时、空数限制、显示作者等)", value: "settings" },
				{ title: "文本正则过滤 (excludeRegex, includeRegex)", value: "text" },
				{ title: "多媒体放行状态 (图片/视频/语音等的放行开关)", value: "media" }
			],
			hint: "- 空格键勾选，回车确认"
		});

		if (editSectionsAns.sections && editSectionsAns.sections.includes("settings")) {
			const settingsAns = await prompts([
				{
					type: "number",
					name: "maxFailures",
					message: `请输入容忍连续空消息的最大数量 (当前: ${maxConsecutiveFailures}):`,
					initial: maxConsecutiveFailures
				},
				{
					type: "number",
					name: "delay",
					message: `请输入基础发送延时毫秒数 (当前: ${delayMs}):`,
					initial: delayMs
				},
				{
					type: "number",
					name: "jMin",
					message: `请输入随机抖动下限系数 (当前: ${jitterMin}):`,
					initial: jitterMin,
					float: true
				},
				{
					type: "number",
					name: "jMax",
					message: `请输入随机抖动上限系数 (当前: ${jitterMax}):`,
					initial: jitterMax,
					float: true
				},
				{
					type: "confirm",
					name: "showSender",
					message: "转发时是否在目标频道显示原消息来源 (如“转发自 X”)？",
					initial: showSenderNames
				},
				{
					type: "confirm",
					name: "commentsOn",
					message: "是否开启频道消息底下的评论区伴随转发功能？",
					initial: commentsCfg.enabled
				}
			]);

			maxConsecutiveFailures = settingsAns.maxFailures ?? maxConsecutiveFailures;
			delayMs = settingsAns.delay ?? delayMs;
			jitterMin = settingsAns.jMin ?? jitterMin;
			jitterMax = settingsAns.jMax ?? jitterMax;
			showSenderNames = settingsAns.showSender ?? showSenderNames;
			
			if (settingsAns.commentsOn !== undefined) {
				commentsCfg.enabled = settingsAns.commentsOn;
				if (commentsCfg.enabled) {
					const modeAns = await prompts({
						type: "select",
						name: "mode",
						message: "请选择评论区消息转发模式:",
						choices: [
							{ title: "全部转发", value: "all" },
							{ title: "仅转发含多媒体的评论", value: "media" }
						],
						initial: commentsCfg.mode === "all" ? 0 : 1
					});
					commentsCfg.mode = modeAns.mode || commentsCfg.mode;
				}
			}
		}

		if (editSectionsAns.sections && editSectionsAns.sections.includes("text")) {
			const textAns = await prompts([
				{
					type: "text",
					name: "exc",
					message: `请输入排除正则表达式 (当前: "${config.filters.text.excludeRegex}"):`,
					initial: config.filters.text.excludeRegex
				},
				{
					type: "text",
					name: "inc",
					message: `请输入包含正则表达式 (当前: "${config.filters.text.includeRegex}"):`,
					initial: config.filters.text.includeRegex
				}
			]);

			config.filters.text.excludeRegex = textAns.exc !== undefined ? textAns.exc.trim() : config.filters.text.excludeRegex;
			config.filters.text.includeRegex = textAns.inc !== undefined ? textAns.inc.trim() : config.filters.text.includeRegex;
		}

		if (editSectionsAns.sections && editSectionsAns.sections.includes("media")) {
			const mediaKeys = [
				{ key: "allowTextOnly", label: "纯文本" },
				{ key: "allowPhoto", label: "图片" },
				{ key: "allowVideo", label: "视频" },
				{ key: "allowDocument", label: "普通文档/文件" },
				{ key: "allowSticker", label: "表情贴纸" },
				{ key: "allowAnimation", label: "动图/GIF" },
				{ key: "allowAudio", label: "音频/音乐" },
				{ key: "allowVoice", label: "语音消息" }
			];

			console.log(`\n  ${colors.bright}多媒体类型过滤自定义状态修改:${colors.reset}`);
			for (const item of mediaKeys) {
				const currentVal = config.filters.mediaTypes[item.key];
				const ans = await prompts({
					type: "confirm",
					name: "allow",
					message: `是否允许转发 [${item.label}] 类型的消息？`,
					initial: currentVal
				});
				if (ans.allow !== undefined) {
					config.filters.mediaTypes[item.key] = ans.allow;
				}
			}
		}
	}

	const dropAuthor = !showSenderNames;
	config.settings.jitterRange = [jitterMin, jitterMax];
	config.settings.comments = commentsCfg;

	// 清除参数提问产生的控制台行，保持最美观
	if (!useDefaultAns.useDefault) {
		clearPreviousLines(5); // 清除大分类提问
	} else {
		clearPreviousLines(1);
	}

	console.log("");
	logInfo(`最终运行参数确认:`);
	logInfo(`- 容忍连续空消息上限: ${colors.bright}${maxConsecutiveFailures}${colors.reset}`);
	logInfo(`- 发送时间间隔: ${colors.bright}${delayMs}ms${colors.reset}`);
	logInfo(`- 随机时间抖动范围: ${colors.bright}[${config.settings.jitterRange.join(", ")}]${colors.reset}`);
	logInfo(`- 显示原消息来源: ${colors.bright}${showSenderNames ? "是 (显示“转发自 X”)" : "否 (隐藏原作者，以本人名义发布)"}${colors.reset}`);
	logInfo(`- 评论区伴随转发: ${colors.bright}${commentsCfg.enabled ? `开启 (模式: ${commentsCfg.mode === "all" ? "全部转发" : "仅转发媒体"})` : "关闭"}${colors.reset}`);
	console.log("");

	const startConfirm = await prompts({
		type: "confirm",
		name: "proceed",
		message: "确认开始自动合并转发？",
		initial: true
	});

	if (!startConfirm.proceed) {
		logWarn("操作已取消。");
		process.exit(0);
	}

	clearPreviousLines(8); // 完美清理确认提问
	logSuccess("🚀 正在启动用户身份转发任务 (支持媒体组自动合并与消息过滤)... \n");

	let currentId = parsed.messageId + 1;
	let consecutiveFailures = 0;
	let successCount = 0;

	let isRunning = true;
	process.on("SIGINT", () => {
		console.log("\n");
		logWarn("收到终止信号 (Ctrl+C)，正在安全退出...");
		isRunning = false;
	});

	while (isRunning) {
		// 检查是否已达到终点消息 ID
		if (targetEndId && currentId > targetEndId) {
			console.log("");
			logSuccess(`🎉 已顺利处理到设定的终点消息 #${targetEndId}，转发任务顺利结束！`);
			break;
		}

		logInfo(`正在拉取源消息 #${colors.bright}${currentId}${colors.reset}...`);

		try {
			// 获取当前消息
			const [msg] = await client.getMessages(sourceEntity, { ids: [currentId] });

			// 判断消息是否不存在
			if (!msg || msg.className === "MessageEmpty") {
				consecutiveFailures++;
				logWarn(`消息 #${currentId} 未找到或已被删除。 (连续空消息: ${consecutiveFailures}/${maxConsecutiveFailures})`);

				if (consecutiveFailures >= maxConsecutiveFailures) {
					console.log("");
					logWarn(`⚠️ 已连续 ${maxConsecutiveFailures} 条消息未找到，判定已到达最新消息，转发任务自动结束。`);
					break;
				}
				currentId++;
				continue;
			}

			// 如果消息存在，重置空消息计数
			consecutiveFailures = 0;

			// 检查是否为成组的消息 (Media Group)
			if (msg.groupedId) {
				const currentGroupId = msg.groupedId.toString();
				logInfo(`检测到属于媒体组 (Grouped ID: ${currentGroupId}) 的消息 #${currentId}。开始向下探寻同组成员...`);

				const groupedMessageIds = [currentId];
				let lookAheadId = currentId + 1;

				// 向下探寻具有相同 groupedId 的连续消息
				while (isRunning) {
					const [nextMsg] = await client.getMessages(sourceEntity, { ids: [lookAheadId] });
					if (nextMsg && nextMsg.groupedId && nextMsg.groupedId.toString() === currentGroupId) {
						groupedMessageIds.push(lookAheadId);
						lookAheadId++;
					} else {
						break;
					}
				}

				logInfo(`成功探寻同组成员！发现成组消息 ID 列表: [${groupedMessageIds.join(", ")}]`);
				
				// 过滤成组内的每一条消息
				const validGroupedIds = [];
				for (const id of groupedMessageIds) {
					const [m] = await client.getMessages(sourceEntity, { ids: [id] });
					if (m) {
						const filterResult = shouldForwardMessage(m);
						if (filterResult.shouldForward) {
							validGroupedIds.push(id);
						} else {
							logWarn(`[过滤跳过] 媒体组成员消息 #${id} 被过滤: ${filterResult.reason}`);
						}
					}
				}

				if (validGroupedIds.length > 0) {
					logInfo(`正在合并打包转发有效媒体组成员: [${validGroupedIds.join(", ")}]...`);
					for (const destEntity of destEntities) {
						await client.forwardMessages(destEntity, {
							messages: validGroupedIds,
							fromPeer: sourceEntity,
							dropAuthor: dropAuthor
						});
					}
					logSuccess(`[成组转发成功] 媒体组 [${validGroupedIds.join(", ")}] 转发成功！`);
					successCount += validGroupedIds.length;

					// 伴随转发评论区
					const commentCount = await forwardComments(msg, sourceEntity, destEntities, dropAuthor, client);
					if (commentCount > 0) {
						successCount += commentCount;
					}
				} else {
					logWarn(`[过滤跳过] 媒体组 [${groupedMessageIds.join(", ")}] 里的所有子消息均未通过过滤条件。`);
				}

				// 将 currentId 跳过整个已处理组
				currentId = lookAheadId;
			} else {
				// 普通单条消息过滤
				const filterResult = shouldForwardMessage(msg);
				if (!filterResult.shouldForward) {
					logWarn(`[过滤跳过] 消息 #${currentId} 未通过过滤条件（原因：${filterResult.reason}）`);
				} else {
					// 转发单条消息
					for (const destEntity of destEntities) {
						await client.forwardMessages(destEntity, {
							messages: [currentId],
							fromPeer: sourceEntity,
							dropAuthor: dropAuthor
						});
					}

					const sneakPeek = msg.message ? ` "${msg.message.trim().substring(0, 25).replace(/\n/g, " ")}..."` : "";
					const msgTypeDesc = getMessageTypeDescription(msg);
					logSuccess(`[${msgTypeDesc}] 消息 #${currentId}${sneakPeek} 转发成功！`);
					successCount++;

					// 伴随转发评论区
					const commentCount = await forwardComments(msg, sourceEntity, destEntities, dropAuthor, client);
					if (commentCount > 0) {
						successCount += commentCount;
					}
				}
				currentId++;
			}

		} catch (error) {
			logError(`处理消息 #${currentId} 时出错: ${error.message}`);
			
			// 如果是 RPCError FLOOD_WAIT_X 延迟，表示触发了 Telegram 限速
			if (error.message.includes("FLOOD_WAIT_")) {
				const seconds = parseInt(error.message.split("_").pop(), 10) || 5;
				logWarn(`⚠️ 触发限速，系统要求强制等待 ${seconds} 秒...`);
				for (let i = seconds; i > 0; i--) {
					if (!isRunning) break;
					process.stdout.write(`等待中: ${i} 秒...\r`);
					await new Promise((resolve) => setTimeout(resolve, 1000));
				}
				console.log("");
				continue; // 重新处理该 ID
			}

			consecutiveFailures++;
			if (consecutiveFailures >= maxConsecutiveFailures) {
				break;
			}
			currentId++;
		}

		// 时间间隔延迟（带随机抖动，更像真人操作，防封号更安全）
		if (isRunning) {
			const jitterMin = config.settings.jitterRange[0];
			const jitterMax = config.settings.jitterRange[1];
			const randomJitter = Math.random() * (jitterMax - jitterMin) + jitterMin;
			const finalDelay = Math.round(delayMs * randomJitter);

			logInfo(`[等待] 随机延时 ${colors.gray}${finalDelay}ms${colors.reset} 后处理下一条...`);
			await new Promise((resolve) => setTimeout(resolve, finalDelay));
		}
	}

	console.log("");
	console.log(`${colors.bright}${colors.cyan}=========================================`);
	console.log(`   任务结束！共成功转发了 ${colors.green}${successCount}${colors.cyan} 条消息。`);
	console.log(`=========================================${colors.reset}\n`);
}

main().catch((err) => {
	logError(`未捕获的运行时异常: ${err.message}`);
	console.error(err);
	process.exit(1);
});
