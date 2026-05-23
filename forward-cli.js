import "dotenv/config";
import { TelegramClient, Api, sessions } from "telegram";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import fs from "node:fs";
import path from "node:path";

const { StringSession } = sessions;
const SESSION_FILE = path.join(process.cwd(), ".session_string");

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

// 检查环境变量
const API_ID = process.env.API_ID ? parseInt(process.env.API_ID, 10) : null;
const API_HASH = process.env.API_HASH;
const DEST_CHANNEL = process.env.DEST_CHANNEL;

if (!API_ID || isNaN(API_ID)) {
	logError("环境变量 API_ID 未设置或格式错误！请检查 .env 文件。");
	process.exit(1);
}
if (!API_HASH) {
	logError("环境变量 API_HASH 未设置！请检查 .env 文件。");
	process.exit(1);
}
if (!DEST_CHANNEL) {
	logError("环境变量 DEST_CHANNEL 未设置！请检查 .env 文件。");
	process.exit(1);
}

// 解析代理配置 (GramJS 原生仅支持 Socks5 代理)
let proxyOptions = undefined;
if (process.env.TELEGRAM_PROXY) {
	try {
		const url = new URL(process.env.TELEGRAM_PROXY);
		// 如果是 http 或 socks5 协议，一律解析为 Socks5 配置 (Clash 等工具均在同端口支持 Socks5)
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

async function main() {
	const rl = readline.createInterface({ input, output });

	console.log(`${colors.bright}${colors.cyan}=========================================`);
	console.log("   Telegram 消息自动转发工具 (用户身份版)   ");
	console.log(`=========================================${colors.reset}\n`);

	logInfo(`当前配置:`);
	logInfo(`目标频道 (DEST_CHANNEL): ${colors.bright}${DEST_CHANNEL}${colors.reset}`);

	// 1. 读取或初始化 Session
	let savedSession = "";
	if (fs.existsSync(SESSION_FILE)) {
		savedSession = fs.readFileSync(SESSION_FILE, "utf-8").trim();
		logInfo("检测到本地已存登录 Session，正在尝试自动登录...");
	} else {
		logWarn("本地未检测到登录 Session，准备开始全新的登录流程。");
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
			phoneNumber: async () => await rl.question(`${colors.bright}请输入你的 Telegram 手机号 (带国家码，如 +86138xxxxxxxx):${colors.reset} `),
			password: async () => await rl.question(`${colors.bright}请输入你的两步验证密码 (若未开启请直接按回车):${colors.reset} `),
			phoneCode: async () => await rl.question(`${colors.bright}请输入收到的 Telegram 登录验证码:${colors.reset} `),
			onError: (err) => logError(`登录异常: ${err.message}`)
		});

		logSuccess("🎉 用户身份登录成功！");
		
		// 保存 Session
		const currentSession = client.session.save();
		fs.writeFileSync(SESSION_FILE, currentSession, "utf-8");
		logInfo("登录凭证已安全保存到本地 .session_string 文件中，下次免登录。\n");
	} catch (loginError) {
		logError(`登录失败: ${loginError.message}`);
		rl.close();
		process.exit(1);
	}

	// 3. 获取并解析消息链接
	let parsed = null;
	while (!parsed) {
		const linkInput = await rl.question(`${colors.bright}请输入起始消息链接 (例如起始消息的链接):${colors.reset}\n> `);
		if (!linkInput.trim()) {
			logWarn("输入不能为空，请重新输入。");
			continue;
		}

		parsed = parseTelegramLink(linkInput);
		if (!parsed) {
			logError("无法解析该链接。请输入正确的 Telegram 消息链接。");
			console.log(`支持的格式:
  - 公开频道: https://t.me/channel_username/123
  - 私有频道: https://t.me/c/123456789/123\n`);
		}
	}

	logSuccess(`成功解析链接！`);
	logInfo(`源频道/群组: ${colors.bright}${parsed.chatId}${colors.reset}`);
	logInfo(`起始消息 ID: ${colors.bright}${parsed.messageId}${colors.reset}`);

	// 4. 解析源和目标实体，确保权限和可见性
	logInfo("正在验证源和目标频道的可见性与访问权限...");
	let sourceEntity = null;
	let destEntity = null;

	try {
		sourceEntity = await client.getEntity(parsed.chatId);
		logSuccess(`成功定位源频道: ${colors.bright}${sourceEntity.title || sourceEntity.username || "私有群组"}${colors.reset}`);
	} catch (err) {
		logError(`无法访问源频道！错误: ${err.message}`);
		logError("请确保你的个人账号已经加入/关注了该频道。");
		rl.close();
		process.exit(1);
	}

	try {
		destEntity = await client.getEntity(DEST_CHANNEL);
		logSuccess(`成功定位目标频道: ${colors.bright}${destEntity.title || destEntity.username || "目标群组"}${colors.reset}\n`);
	} catch (err) {
		logError(`无法访问目标频道 (${DEST_CHANNEL})！错误: ${err.message}`);
		logError("请确保你的个人账号在此目标频道中拥有发布消息的权限。");
		rl.close();
		process.exit(1);
	}

	// 5. 参数确认
	let maxConsecutiveFailures = 30;
	let delayMs = 1500; // 用户账号建议设置大一点（如 1.5s - 2s）以防止封号或触发限制

	const useDefault = await rl.question(`${colors.bright}是否使用默认转发设置？ (容忍连续 30 条空消息, 发送间隔 1500ms) [Y/n]:${colors.reset} `);
	if (useDefault.trim().toLowerCase() === "n") {
		const customMax = await rl.question(`请输入容忍连续空消息的最大数量 (默认: 30): `);
		if (customMax.trim() && !isNaN(customMax)) {
			maxConsecutiveFailures = parseInt(customMax, 10);
		}

		const customDelay = await rl.question(`请输入每次发送的时间间隔毫秒数 (默认: 1500): `);
		if (customDelay.trim() && !isNaN(customDelay)) {
			delayMs = parseInt(customDelay, 10);
		}
	}

	console.log("");
	logInfo(`参数确认:`);
	logInfo(`- 容忍连续空消息上限: ${colors.bright}${maxConsecutiveFailures}${colors.reset}`);
	logInfo(`- 发送时间间隔: ${colors.bright}${delayMs}ms${colors.reset}`);
	console.log("");

	const proceed = await rl.question(`${colors.bright}确认开始自动合并转发？ [Y/n]:${colors.reset} `);
	if (proceed.trim().toLowerCase() === "n") {
		logWarn("操作已取消。");
		rl.close();
		process.exit(0);
	}

	rl.close();

	logSuccess("🚀 正在启动用户身份转发任务 (支持媒体组自动合并)... \n");

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
					logWarn(`⚠️ 已连续 ${maxConsecutiveFailures} 条消息未找到，判定已到达频道最新消息，转发任务自动结束。`);
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
				logInfo(`合并打包转发媒体组...`);

				// 批量合并转发，GramJS 会自动保持媒体成组状态！
				await client.forwardMessages(destEntity, {
					messages: groupedMessageIds,
					fromPeer: sourceEntity
				});

				logSuccess(`[成组转发成功] 媒体组 [${groupedMessageIds.join(", ")}] 转发成功！`);
				successCount += groupedMessageIds.length;

				// 将 currentId 跳过整个已转发组
				currentId = lookAheadId;
			} else {
				// 普通单条消息转发
				await client.forwardMessages(destEntity, {
					messages: [currentId],
					fromPeer: sourceEntity
				});

				logSuccess(`消息 #${currentId} 转发成功！`);
				successCount++;
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

			// 遇到其他不可恢复的报错
			consecutiveFailures++;
			if (consecutiveFailures >= maxConsecutiveFailures) {
				break;
			}
			currentId++;
		}

		// 时间间隔延迟（带随机抖动，模拟真人操作，防封号更安全）
		if (isRunning) {
			// 随机抖动范围：基础延迟的 85% ~ 135%
			const jitterMin = 0.85;
			const jitterMax = 1.35;
			const randomJitter = Math.random() * (jitterMax - jitterMin) + jitterMin;
			const finalDelay = Math.round(delayMs * randomJitter);

			logInfo(`[等待] 随机延时 ${colors.gray}${finalDelay}ms${colors.reset} 后处理下一条...`);
			await new Promise((resolve) => setTimeout(resolve, finalDelay));
		}
	}

	console.log("");
	console.log(`${colors.bright}${colors.cyan}=========================================`);
	console.log(`   任务完成！共成功转发了 ${colors.green}${successCount}${colors.cyan} 条消息。`);
	console.log(`=========================================${colors.reset}\n`);
}

main().catch((err) => {
	logError(`未捕获的运行时异常: ${err.message}`);
	console.error(err);
	process.exit(1);
});
