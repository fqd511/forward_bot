import "dotenv/config";
import { TelegramClient, Api, sessions } from "telegram";
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
		jitterRange: [0.95, 1.45]
	}
};

if (fs.existsSync(CONFIG_FILE)) {
	try {
		const parsedConfig = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8"));
		// 进行简单的深度合并，保证配置文件中缺少某些字段时能正确读取到最头部的默认配置
		config.filters.text = { ...config.filters.text, ...parsedConfig.filters?.text };
		config.filters.mediaTypes = { ...config.filters.mediaTypes, ...parsedConfig.filters?.mediaTypes };
		config.settings = { ...config.settings, ...parsedConfig.settings };
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

async function main() {
	const rl = readline.createInterface({ input, output });

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
	
	let selectedSessionFile = "";
	let savedSession = "";
	let phoneNumber = "";

	if (sessionFiles.length > 0) {
		console.log(`\n${colors.bright}本地已保存账号列表:${colors.reset}`);
		sessionFiles.forEach((file, index) => {
			const accName = file.replace(".session", "");
			console.log(`  ${colors.cyan}${index + 1}.${colors.reset} ${accName}`);
		});
		console.log(`  ${colors.cyan}${sessionFiles.length + 1}.${colors.reset} ${colors.green}[+] 登录全新账号${colors.reset}`);

		let choice = -1;
		while (choice < 1 || choice > sessionFiles.length + 1) {
			const ans = await rl.question(`\n请选择登录账号序号 (1 - ${sessionFiles.length + 1}): `);
			const parsedChoice = parseInt(ans.trim(), 10);
			if (!isNaN(parsedChoice)) {
				choice = parsedChoice;
			}
		}

		if (choice === sessionFiles.length + 1) {
			// 登录新账号
			while (!phoneNumber) {
				const numInput = await rl.question(`\n${colors.bright}请输入你要登录的手机号 (带国家码，如 +86138xxxxxxxx):${colors.reset} `);
				phoneNumber = numInput.trim();
			}
			selectedSessionFile = path.join(SESSIONS_DIR, `${phoneNumber}.session`);
		} else {
			// 使用已有账号
			const file = sessionFiles[choice - 1];
			phoneNumber = file.replace(".session", "");
			selectedSessionFile = path.join(SESSIONS_DIR, file);
			savedSession = fs.readFileSync(selectedSessionFile, "utf-8").trim();
			logInfo(`已选择账号: ${colors.bright}${phoneNumber}${colors.reset}，正在尝试自动登录并连接...`);
		}
	} else {
		logWarn("本地未检测到任何已登录账号，准备开始全新登录流程。");
		while (!phoneNumber) {
			const numInput = await rl.question(`\n${colors.bright}请输入你要登录的手机号 (带国家码，如 +86138xxxxxxxx):${colors.reset} `);
			phoneNumber = numInput.trim();
		}
		selectedSessionFile = path.join(SESSIONS_DIR, `${phoneNumber}.session`);
	}

	const stringSession = new StringSession(savedSession);
	const client = new TelegramClient(stringSession, API_ID, API_HASH, {
		connectionRetries: 5,
		useWSS: false,
		proxy: proxyOptions
	});

	// 2. 登录认证
	try {
		await client.start({
			phoneNumber: async () => phoneNumber,
			password: async () => await rl.question(`${colors.bright}请输入你的两步验证密码 (若未开启请直接按回车):${colors.reset} `),
			phoneCode: async () => await rl.question(`${colors.bright}请输入收到的 Telegram 登录验证码:${colors.reset} `),
			onError: (err) => logError(`登录异常: ${err.message}`)
		});

		logSuccess(`🎉 账号 ${phoneNumber} 登录成功！`);
		
		// 保存 Session
		const currentSession = client.session.save();
		fs.writeFileSync(selectedSessionFile, currentSession, "utf-8");
		logInfo(`凭证已安全保存到本地 .sessions 文件夹中。\n`);
	} catch (loginError) {
		logError(`登录/连接失败: ${loginError.message}`);
		rl.close();
		process.exit(1);
	}

	// 2.5 获取并加载所有可用的目标频道实体信息 (用于生成直观易读的选择菜单)
	logInfo("正在拉取已配制目标频道的名称与状态以生成可读性选择菜单...");
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
		logError("错误：配置文件中所配制的目标频道均无法访问，请检查 forward-config.json 的 destinations 配置！");
		rl.close();
		process.exit(1);
	}

	let activeDestEntities = [];
	if (resolvedDestinations.length === 1) {
		activeDestEntities = [resolvedDestinations[0].entity];
		logInfo(`已自动选择唯一配置的目标频道: ${colors.bright}${resolvedDestinations[0].title}${colors.reset} (${resolvedDestinations[0].address})\n`);
	} else {
		console.log(`\n${colors.bright}可供选择的目标频道列表:${colors.reset}`);
		resolvedDestinations.forEach((destObj, index) => {
			console.log(`  ${colors.cyan}${index + 1}.${colors.reset} ${colors.bright}${destObj.title}${colors.reset} (${colors.gray}${destObj.address}${colors.reset})`);
		});
		console.log(`  ${colors.cyan}${resolvedDestinations.length + 1}.${colors.reset} ${colors.green}[全部同时发送]${colors.reset}`);

		let chosenIndices = [];
		while (chosenIndices.length === 0) {
			const ans = await rl.question(`\n请选择本次要转发的目标频道序号 (支持多选，用逗号分隔，如 '1' 或 '1,3' 或 '${resolvedDestinations.length + 1}'): `);
			const parts = ans.split(",").map(p => p.trim());
			
			for (const part of parts) {
				const num = parseInt(part, 10);
				if (!isNaN(num)) {
					if (num === resolvedDestinations.length + 1) {
						chosenIndices = resolvedDestinations.map((_, i) => i);
						break;
					} else if (num >= 1 && num <= resolvedDestinations.length) {
						chosenIndices.push(num - 1);
					}
				}
			}
			
			if (chosenIndices.length === 0) {
				logWarn("无效的序号选择，请重新选择！");
			}
		}
		
		const uniqueIndices = [...new Set(chosenIndices)];
		activeDestEntities = uniqueIndices.map(i => resolvedDestinations[i].entity);
		const chosenTitles = uniqueIndices.map(i => resolvedDestinations[i].title);
		logSuccess(`成功选择 ${colors.bright}${activeDestEntities.length}${colors.reset} 个目标频道: [${chosenTitles.join(", ")}]\n`);
	}

	// 3. 获取并解析消息链接（起始 & 结束）
	let parsed = null;
	while (!parsed) {
		const linkInput = await rl.question(`${colors.bright}请输入【起始】消息链接 (从它的下一条消息开始转发):${colors.reset}\n> `);
		if (!linkInput.trim()) {
			logWarn("输入不能为空，请重新输入。");
			continue;
		}

		parsed = parseTelegramLink(linkInput);
		if (!parsed) {
			logError("无法解析该链接。请输入正确的 Telegram 消息链接。");
			console.log(`支持的格式:
  - 公开频道: https://t.me/channel_username/123
  - Private channel: https://t.me/c/123456789/123\n`);
		}
	}

	let endParsed = null;
	while (true) {
		const endLinkInput = await rl.question(`${colors.bright}请输入【结束】消息链接 (可选，留空代表一直转发到最新可用消息):${colors.reset}\n> `);
		if (!endLinkInput.trim()) {
			break; // 用户留空，执行到最新消息
		}

		endParsed = parseTelegramLink(endLinkInput);
		if (!endParsed) {
			logError("无法解析该结束链接，请重新输入或直接按回车留空。");
			continue;
		}

		if (endParsed.chatId !== parsed.chatId) {
			logError("错误：结束消息所在的频道与起始消息所在的频道不一致，请重新输入！");
			endParsed = null;
			continue;
		}

		if (endParsed.messageId <= parsed.messageId) {
			logError(`错误：结束消息 ID (${endParsed.messageId}) 必须大于起始消息 ID (${parsed.messageId})，请重新输入！`);
			endParsed = null;
			continue;
		}

		break;
	}

	logSuccess(`成功解析链接！`);
	logInfo(`源频道/群组 ID: ${colors.bright}${parsed.chatId}${colors.reset}`);
	logInfo(`起始消息 ID: ${colors.bright}${parsed.messageId}${colors.reset}`);
	if (endParsed) {
		logInfo(`设定结束消息 ID: ${colors.bright}${endParsed.messageId}${colors.reset}`);
	} else {
		logInfo(`未指定结束链接，将自动转发到频道最新一条消息。`);
	}

	// 4. 解析并验证源频道可见性与访问权限
	logInfo("正在验证源频道的可见性与访问权限...");
	let sourceEntity = null;
	const destEntities = [...activeDestEntities]; // 目标实体在上一步已成功解析并过滤，这里直接复用即可！

	try {
		sourceEntity = await client.getEntity(parsed.chatId);
		logSuccess(`成功定位源频道: ${colors.bright}${sourceEntity.title || sourceEntity.username || "私有群组"}${colors.reset}\n`);
	} catch (err) {
		logError(`无法访问源频道！错误: ${err.message}`);
		logError("请确保你的个人账号已经加入/关注了该频道。");
		rl.close();
		process.exit(1);
	}

	// 5. 动态获取频道的最新一条消息 ID
	let latestId = null;
	try {
		const latestMessages = await client.getMessages(sourceEntity, { limit: 1 });
		if (latestMessages && latestMessages.length > 0) {
			latestId = latestMessages[0].id;
			logInfo(`检测到源频道当前最新消息 ID 为: ${colors.bright}${latestId}${colors.reset}`);
		}
	} catch (err) {
		logWarn(`无法获取频道最新消息 ID (${err.message})，将仅依赖空消息数量来自动判定任务终止。`);
	}

	// 设定本次任务的物理终点 ID
	const targetEndId = endParsed ? endParsed.messageId : latestId;
	const sourceTitle = sourceEntity.title || sourceEntity.username || parsed.chatId;
	if (targetEndId) {
		logInfo(`任务范围: 从频道 【${colors.bright}${sourceTitle}${colors.reset}】 的消息 #${colors.bright}${parsed.messageId + 1}${colors.reset} 遍历转发至 #${colors.bright}${targetEndId}${colors.reset}\n`);
	} else {
		logInfo(`任务范围: 从频道 【${colors.bright}${sourceTitle}${colors.reset}】 的消息 #${colors.bright}${parsed.messageId + 1}${colors.reset} 转发至最新消息，连续空消息触发上限时自动停止。\n`);
	}

	// 6. 运行参数配置 (直接读取最头部已初始化默认值的 config 对象)
	let maxConsecutiveFailures = config.settings.maxConsecutiveFailures;
	let delayMs = config.settings.delayMs;
	const showSenderNames = config.settings.showSenderNames;
	const dropAuthor = !showSenderNames;

	const useDefault = await rl.question(`${colors.bright}是否使用配置文件中的运行设置？ (容忍连续 ${maxConsecutiveFailures} 条空消息, 发送间隔 ${delayMs}ms) [Y/n]:${colors.reset} `);
	if (useDefault.trim().toLowerCase() === "n") {
		const customMax = await rl.question(`请输入容忍连续空消息的最大数量 (默认: ${maxConsecutiveFailures}): `);
		if (customMax.trim() && !isNaN(customMax)) {
			maxConsecutiveFailures = parseInt(customMax, 10);
		}

		const customDelay = await rl.question(`请输入每次发送的时间间隔毫秒数 (默认: ${delayMs}): `);
		if (customDelay.trim() && !isNaN(customDelay)) {
			delayMs = parseInt(customDelay, 10);
		}
	}

	console.log("");
	logInfo(`参数确认:`);
	logInfo(`- 容忍连续空消息上限: ${colors.bright}${maxConsecutiveFailures}${colors.reset}`);
	logInfo(`- 发送时间间隔: ${colors.bright}${delayMs}ms${colors.reset}`);
	logInfo(`- 显示原消息来源: ${colors.bright}${showSenderNames ? "是 (显示“转发自 X”)" : "否 (隐藏原作者，以本人名义发布)"}${colors.reset}`);
	console.log("");

	const proceed = await rl.question(`${colors.bright}确认开始自动合并转发？ [Y/n]:${colors.reset} `);
	if (proceed.trim().toLowerCase() === "n") {
		logWarn("操作已取消。");
		rl.close();
		process.exit(0);
	}

	rl.close();

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
