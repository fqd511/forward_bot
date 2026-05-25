import "dotenv/config";
import express from "express";
import path from "node:path";
import fs from "node:fs";

// Setup server & ports
const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const __dirname = path.resolve();

// Create logs directory
const LOG_DIR = path.join(__dirname, "logs");
if (!fs.existsSync(LOG_DIR)) {
	fs.mkdirSync(LOG_DIR, { recursive: true });
}
const LOG_FILE = path.join(LOG_DIR, "forward_bot.log");

/**
 * Write detailed log to local file and terminal stdout
 */
function writeLog(tabId, tabName, level, message) {
	const timestamp = new Date().toISOString().replace("T", " ").substring(0, 19);
	const tabLabel = tabName ? `Tab: ${tabName}` : "Global";
	const fileLogLine = `[${timestamp}] [${tabLabel}] [${level}] ${message}`;
	const terminalLogLine = `\x1b[90m[${timestamp}]\x1b[0m \x1b[36m[${tabLabel}]\x1b[0m \x1b[1m[${level}]\x1b[0m ${message}`;
	
	console.log(terminalLogLine);
	try {
		fs.appendFileSync(LOG_FILE, fileLogLine + "\n", "utf-8");
	} catch (err) {
		console.error("Failed to write log to file:", err.message);
	}
}

// Memory caches
const loginClients = new Map(); // phone -> { client, phoneCodeHash, apiId, apiHash }
const clientCache = new Map();  // sessionString -> { client, connected: true }

/**
 * Parses socks5/http proxy URL into GramJS options
 */
function parseProxy(proxyUrl) {
	if (!proxyUrl) return undefined;
	try {
		const url = new URL(proxyUrl);
		return {
			ip: url.hostname,
			port: parseInt(url.port, 10),
			socksType: 5, // GramJS natively expects SOCKS5
			timeout: 5
		};
	} catch (e) {
		return undefined;
	}
}

/**
 * Gets or creates cached TelegramClient
 */
async function getTelegramClient(sessionString, apiId, apiHash, proxyOptions) {
	if (clientCache.has(sessionString)) {
		const cached = clientCache.get(sessionString);
		try {
			// Quick ping/check to see if still connected
			if (cached.client.connected) {
				return cached.client;
			}
		} catch (e) {
			// Reconnect below
		}
	}

	const { TelegramClient, sessions } = await import("telegram");
	const { StringSession } = sessions;
	
	const stringSession = new StringSession(sessionString);
	const client = new TelegramClient(stringSession, parseInt(apiId, 10), apiHash, {
		connectionRetries: 3,
		useWSS: false,
		proxy: proxyOptions
	});

	await client.connect();
	clientCache.set(sessionString, { client, connected: true });
	return client;
}

/**
 * Get friendly description of Telegram message type
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
 * Filter messages based on configuration
 */
function shouldForwardMessage(msg, config) {
	// 1. Text filter
	const msgText = msg.message || "";
	const textFilters = config?.filters?.text;
	
	if (textFilters) {
		if (textFilters.excludeRegex) {
			try {
				const excludeReg = new RegExp(textFilters.excludeRegex, "i");
				if (excludeReg.test(msgText)) {
					return { shouldForward: false, reason: `文本匹配到排除正则: "${textFilters.excludeRegex}"` };
				}
			} catch (e) {
				// Invalid regex, handled by UI tester or ignored
			}
		}
		if (textFilters.includeRegex) {
			try {
				const includeReg = new RegExp(textFilters.includeRegex, "i");
				if (!includeReg.test(msgText)) {
					return { shouldForward: false, reason: `文本未匹配到包含正则: "${textFilters.includeRegex}"` };
				}
			} catch (e) {
				// Invalid regex
			}
		}
	}

	// 2. Media Type filter
	const mediaTypes = config?.filters?.mediaTypes;
	if (mediaTypes) {
		const media = msg.media;
		if (!media) {
			if (!mediaTypes.allowTextOnly) {
				return { shouldForward: false, reason: "配置禁用了纯文本消息 (allowTextOnly: false)" };
			}
		} else {
			const className = media.className;
			
			if (className === "MessageMediaPhoto") {
				if (!mediaTypes.allowPhoto) {
					return { shouldForward: false, reason: "配置禁用了图片消息 (allowPhoto: false)" };
				}
			} else if (className === "MessageMediaDocument") {
				const document = media.document;
				const mimeType = document?.mimeType || "";
				
				let isSticker = false;
				let isGif = false;
				let isVideo = false;
				let isAudio = false;
				let isVoice = false;

				if (mimeType.includes("image/webp")) isSticker = true;
				if (mimeType.includes("image/gif")) isGif = true;
				if (mimeType.startsWith("video/")) isVideo = true;
				if (mimeType.startsWith("audio/")) isAudio = true;

				if (document && document.attributes) {
					for (const attr of document.attributes) {
						if (attr.className === "DocumentAttributeAnimated") isGif = true;
						if (attr.className === "DocumentAttributeSticker") isSticker = true;
						if (attr.className === "DocumentAttributeVideo") isVideo = true;
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
				
				const isOtherDoc = !isSticker && !isGif && !isVideo && !isVoice && !isAudio;
				if (isOtherDoc && !mediaTypes.allowDocument) {
					return { shouldForward: false, reason: "配置禁用了普通文档/文件消息 (allowDocument: false)" };
				}
			} else {
				if (!mediaTypes.allowDocument) {
					return { shouldForward: false, reason: "配置禁用了非文件类其他媒体消息 (allowDocument: false)" };
				}
			}
		}
	}

	return { shouldForward: true };
}

/**
 * Handle comments forwarding
 */
async function forwardComments(msg, sourceEntity, destEntities, dropAuthor, clientInstance, config, addLog) {
	const commentsConfig = config?.settings?.comments ?? {};
	if (!commentsConfig.enabled) return 0;
	if (!msg.replies) return 0;

	const mode = commentsConfig.mode || "all";
	const { Api } = await import("telegram");

	let commentsResult;
	try {
		commentsResult = await clientInstance.invoke(new Api.messages.GetReplies({
			peer: sourceEntity,
			msgId: msg.id,
			offsetId: 0,
			offsetDate: 0,
			addOffset: 0,
			limit: 100,
			maxId: 0,
			minId: 0,
			hash: 0n
		}));
	} catch (err) {
		addLog("Warn", `获取评论区消息失败: ${err.message}，跳过评论区转发。`);
		return 0;
	}

	let rawComments = commentsResult.messages.filter(m =>
		m.id !== msg.id && m.className !== "MessageEmpty"
	);

	if (rawComments.length === 0) return 0;

	let discussionPeer;
	try {
		discussionPeer = await clientInstance.getEntity(rawComments[0].peerId);
	} catch (err) {
		addLog("Warn", `无法获取讨论群实体: ${err.message}，跳过评论区转发。`);
		return 0;
	}

	let commentsToForward;
	if (mode === "media") {
		commentsToForward = rawComments.filter(m => {
			if (m.photo || m.video || m.audio || m.voice) return true;
			if (m.document) {
				const mime = m.document.mimeType || "";
				if (mime.includes("image/webp")) return false;
				return true;
			}
			return false;
		});
	} else {
		commentsToForward = [...rawComments];
	}

	if (commentsToForward.length === 0) return 0;

	const modeLabel = mode === "media" ? "仅媒体" : "全部";
	addLog("Info", `正在转发 ${commentsToForward.length} 条评论区消息 (${modeLabel})...`);

	const groupMap = new Map();
	const singles = [];
	for (const c of commentsToForward) {
		if (c.groupedId) {
			const gid = c.groupedId.toString();
			if (!groupMap.has(gid)) groupMap.set(gid, []);
			groupMap.get(gid).push(c);
		} else {
			singles.push(c);
		}
	}

	for (const [, group] of groupMap) {
		group.sort((a, b) => a.id - b.id);
		const ids = group.map(c => c.id);
		for (const destEntity of destEntities) {
			try {
				await clientInstance.forwardMessages(destEntity, {
					messages: ids,
					fromPeer: discussionPeer,
					dropAuthor: dropAuthor
				});
			} catch (err) {
				addLog("Warn", `转发评论组 #${ids.join(", #")} 失败: ${err.message}`);
			}
		}
		await new Promise(resolve => setTimeout(resolve, 300));
	}

	for (const comment of singles) {
		for (const destEntity of destEntities) {
			try {
				await clientInstance.forwardMessages(destEntity, {
					messages: [comment.id],
					fromPeer: discussionPeer,
					dropAuthor: dropAuthor
				});
			} catch (err) {
				addLog("Warn", `转发评论 #${comment.id} 失败: ${err.message}`);
			}
		}
		await new Promise(resolve => setTimeout(resolve, 300));
	}

	addLog("Success", `成功附带转发 ${commentsToForward.length} 条评论区消息 ✓`);
	return commentsToForward.length;
}

// ================= API ENDPOINTS =================

/**
 * Endpoint to retrieve initial settings from environmental/local files
 */
app.get("/api/init", (req, res) => {
	let localConfig = null;
	const CONFIG_FILE = path.join(__dirname, "forward-config.json");
	try {
		if (fs.existsSync(CONFIG_FILE)) {
			localConfig = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8"));
		}
	} catch (e) {
		// ignore
	}
	
	res.json({
		API_ID: process.env.API_ID || "",
		API_HASH: process.env.API_HASH || "",
		TELEGRAM_PROXY: process.env.TELEGRAM_PROXY || "",
		DEST_CHANNEL: process.env.DEST_CHANNEL || "",
		localConfig
	});
});

/**
 * Step 1 of Auth: Send verification SMS
 */
app.post("/api/auth/send-code", async (req, res) => {
	try {
		const { phone, apiId, apiHash, proxy } = req.body;
		if (!phone || !apiId || !apiHash) {
			return res.status(400).json({ error: "请输入手机号、API_ID 和 API_HASH" });
		}
		
		const proxyOptions = parseProxy(proxy);
		const { TelegramClient, sessions } = await import("telegram");
		const { StringSession } = sessions;
		
		const client = new TelegramClient(new StringSession(""), parseInt(apiId, 10), apiHash, {
			connectionRetries: 3,
			useWSS: false,
			proxy: proxyOptions
		});
		
		await client.connect();
		
		const result = await client.sendCode({
			apiId: parseInt(apiId, 10),
			apiHash
		}, phone);
		
		loginClients.set(phone, { client, phoneCodeHash: result.phoneCodeHash, apiId, apiHash, proxyOptions });
		
		writeLog(null, null, "Info", `验证码已发送至手机号: ${phone}`);
		res.json({ success: true, phoneCodeHash: result.phoneCodeHash });
	} catch (err) {
		writeLog(null, null, "Error", `发送验证码失败: ${err.message}`);
		res.status(500).json({ error: err.message });
	}
});

/**
 * Step 2 of Auth: Submit SMS and 2FA password
 */
app.post("/api/auth/sign-in", async (req, res) => {
	try {
		const { phone, code, password } = req.body;
		if (!phone || !code) {
			return res.status(400).json({ error: "请输入手机号和验证码" });
		}
		
		const sessionData = loginClients.get(phone);
		if (!sessionData) {
			return res.status(400).json({ error: "未找到该手机号的登录流程，请重新获取验证码" });
		}
		
		const { client, phoneCodeHash } = sessionData;
		let me;
		
		try {
			me = await client.signIn({
				phoneNumber: phone,
				phoneCodeHash: phoneCodeHash,
				phoneCode: code
			});
		} catch (signInErr) {
			if (signInErr.message.includes("SESSION_PASSWORD_NEEDED") || signInErr.name === "SessionPasswordNeededError") {
				if (!password) {
					return res.json({ success: false, requiresPassword: true });
				}
				
				me = await client.signIn({
					password: password
				});
			} else {
				throw signInErr;
			}
		}
		
		const sessionString = client.session.save();
		const user = await client.getMe();
		const name = `${user.firstName || ""} ${user.lastName || ""}`.trim() + (user.username ? ` (@${user.username})` : "");
		
		loginClients.delete(phone);
		
		// Cache for future requests
		clientCache.set(sessionString, { client, connected: true });
		
		writeLog(null, null, "Success", `用户 [${name}] 登录成功！`);
		res.json({
			success: true,
			sessionString,
			name,
			user: {
				id: user.id.toString(),
				username: user.username,
				phone: user.phone
			}
		});
	} catch (err) {
		writeLog(null, null, "Error", `验证码登录失败: ${err.message}`);
		res.status(500).json({ error: err.message });
	}
});

/**
 * Bot Token authentication
 */
app.post("/api/auth/verify-bot", async (req, res) => {
	try {
		const { botToken, apiId, apiHash, proxy } = req.body;
		if (!botToken || !apiId || !apiHash) {
			return res.status(400).json({ error: "请输入 Bot Token, API_ID 和 API_HASH" });
		}
		
		const proxyOptions = parseProxy(proxy);
		const { TelegramClient, sessions } = await import("telegram");
		const { StringSession } = sessions;
		
		const client = new TelegramClient(new StringSession(""), parseInt(apiId, 10), apiHash, {
			connectionRetries: 3,
			useWSS: false,
			proxy: proxyOptions
		});
		
		await client.start({
			botAuthToken: botToken
		});
		
		const sessionString = client.session.save();
		const me = await client.getMe();
		const name = `👑 [Bot] ${me.firstName || ""}`.trim() + (me.username ? ` (@${me.username})` : "");
		
		clientCache.set(sessionString, { client, connected: true });
		
		writeLog(null, null, "Success", `Bot [${name}] 登录成功！`);
		res.json({
			success: true,
			sessionString,
			name,
			bot: {
				id: me.id.toString(),
				firstName: me.firstName,
				username: me.username
			}
		});
	} catch (err) {
		writeLog(null, null, "Error", `Bot 登录验证失败: ${err.message}`);
		res.status(500).json({ error: err.message });
	}
});

/**
 * Verify a telegram group, channel or chat
 */
app.post("/api/verify-entity", async (req, res) => {
	try {
		const { sessionString, apiId, apiHash, entityId, proxy } = req.body;
		if (!sessionString || !apiId || !apiHash || !entityId) {
			return res.status(400).json({ error: "缺少必要的连接验证参数" });
		}
		
		const proxyOptions = parseProxy(proxy);
		const client = await getTelegramClient(sessionString, apiId, apiHash, proxyOptions);
		
		const entity = await client.getEntity(entityId);
		const title = entity.title || `${entity.firstName || ""} ${entity.lastName || ""}`.trim() || entity.username || entityId;
		
		res.json({
			success: true,
			id: entity.id.toString(),
			title: title,
			username: entity.username || null,
			className: entity.className
		});
	} catch (err) {
		res.status(500).json({ error: err.message });
	}
});

/**
 * Message preview
 */
app.post("/api/preview", async (req, res) => {
	try {
		const { sessionString, apiId, apiHash, sourceChat, messageId, proxy, config } = req.body;
		if (!sessionString || !apiId || !apiHash || !sourceChat || !messageId) {
			return res.status(400).json({ error: "缺少必要的预览拉取参数" });
		}
		
		const proxyOptions = parseProxy(proxy);
		const client = await getTelegramClient(sessionString, apiId, apiHash, proxyOptions);
		
		const sourceEntity = await client.getEntity(sourceChat);
		const [msg] = await client.getMessages(sourceEntity, { ids: [parseInt(messageId, 10)] });
		
		if (!msg || msg.className === "MessageEmpty") {
			return res.json({ success: false, error: `待转发起始消息 #${messageId} 不存在或已被删除。` });
		}
		
		const msgType = getMessageTypeDescription(msg);
		const text = msg.message || "";
		const sender = msg.sender ? (msg.sender.title || `${msg.sender.firstName || ""} ${msg.sender.lastName || ""}`.trim() || msg.sender.username) : null;
		
		// Background download photo/video thumbnail as Base64 (failsafe, no heavy downloads)
		let mediaBase64 = null;
		if (msg.media) {
			try {
				const isPhoto = msg.photo || msg.media.className === "MessageMediaPhoto";
				const isDocument = msg.media.className === "MessageMediaDocument";
				
				if (isPhoto) {
					const buffer = await client.downloadMedia(msg, { workers: 1 });
					if (buffer) {
						mediaBase64 = `data:image/jpeg;base64,${buffer.toString("base64")}`;
					}
				} else if (isDocument && msg.media.document) {
					const doc = msg.media.document;
					if (doc.thumbs && doc.thumbs.length > 0) {
						// Download the largest thumbnail size which is usually the last one
						const largestThumbIdx = doc.thumbs.length - 1;
						const buffer = await client.downloadMedia(msg, { thumb: largestThumbIdx, workers: 1 });
						if (buffer) {
							mediaBase64 = `data:image/jpeg;base64,${buffer.toString("base64")}`;
						}
					}
				}
			} catch (mediaErr) {
				console.error("Failed to generate base64 preview:", mediaErr.message);
			}
		}
		
		res.json({
			success: true,
			message: {
				id: msg.id,
				text,
				type: msgType,
				sender,
				date: msg.date,
				groupedId: msg.groupedId ? msg.groupedId.toString() : null,
				mediaBase64
			},
			verdict: config ? shouldForwardMessage(msg, config) : { shouldForward: true }
		});
	} catch (err) {
		res.status(500).json({ error: err.message });
	}
});

/**
 * Forward single-step (stateless forwarding orchestrated by client)
 */
app.post("/api/forward", async (req, res) => {
	const { tabId, tabName, sessionString, apiId, apiHash, sourceChat, currentId, destChats, config, proxy } = req.body;
	
	if (!sessionString || !apiId || !apiHash || !sourceChat || !currentId || !destChats || !destChats.length) {
		return res.status(400).json({ error: "缺少必要的转发操作参数" });
	}
	
	const logs = [];
	const addLog = (level, message) => {
		const timestamp = new Date().toISOString().replace("T", " ").substring(0, 19);
		logs.push({ timestamp, level, message });
		writeLog(tabId, tabName, level, message);
	};
	
	try {
		const proxyOptions = parseProxy(proxy);
		const client = await getTelegramClient(sessionString, apiId, apiHash, proxyOptions);
		
		const sourceEntity = await client.getEntity(sourceChat);
		
		// Get all valid destination entities
		const destEntities = [];
		for (const dest of destChats) {
			try {
				const entity = await client.getEntity(dest);
				destEntities.push(entity);
			} catch (err) {
				addLog("Warn", `目标频道 [${dest}] 无法访问，跳过此目标。原因: ${err.message}`);
			}
		}
		
		if (destEntities.length === 0) {
			return res.status(400).json({ error: "所选择的目标频道均不可访问", logs });
		}
		
		const targetId = parseInt(currentId, 10);
		addLog("Info", `正在读取源消息 #${targetId}...`);
		
		const [msg] = await client.getMessages(sourceEntity, { ids: [targetId] });
		
		// 1. Check if empty
		if (!msg || msg.className === "MessageEmpty") {
			addLog("Warn", `消息 #${targetId} 未找到或已被删除。`);
			return res.json({
				success: true,
				empty: true,
				nextId: targetId + 1,
				logs
			});
		}
		
		const dropAuthor = !config.settings.showSenderNames;
		let successCount = 0;
		let nextId = targetId + 1;
		
		// 2. Check if grouped
		if (msg.groupedId) {
			const currentGroupId = msg.groupedId.toString();
			addLog("Info", `检测到媒体组 (Grouped ID: ${currentGroupId})，开始获取全部组员...`);
			
			const groupedMessageIds = [targetId];
			let lookAheadId = targetId + 1;
			
			// Scan lookahead for elements in same group
			while (lookAheadId < targetId + 20) {
				const [nextMsg] = await client.getMessages(sourceEntity, { ids: [lookAheadId] });
				if (nextMsg && nextMsg.groupedId && nextMsg.groupedId.toString() === currentGroupId) {
					groupedMessageIds.push(lookAheadId);
					lookAheadId++;
				} else {
					break;
				}
			}
			
			addLog("Info", `媒体组探寻结束。同组成员 ID 列表: [${groupedMessageIds.join(", ")}]`);
			
			// Filter each sub-message in group
			const validGroupedIds = [];
			for (const id of groupedMessageIds) {
				const [m] = await client.getMessages(sourceEntity, { ids: [id] });
				if (m) {
					const filterResult = shouldForwardMessage(m, config);
					if (filterResult.shouldForward) {
						validGroupedIds.push(id);
					} else {
						addLog("Warn", `[过滤跳过] 媒体组成员消息 #${id} 未通过过滤条件: ${filterResult.reason}`);
					}
				}
			}
			
			if (validGroupedIds.length > 0) {
				addLog("Info", `正在合并发送媒体组 [${validGroupedIds.join(", ")}]...`);
				for (const destEntity of destEntities) {
					await client.forwardMessages(destEntity, {
						messages: validGroupedIds,
						fromPeer: sourceEntity,
						dropAuthor: dropAuthor
					});
				}
				addLog("Success", `[成组转发成功] 媒体组 [${validGroupedIds.join(", ")}] 转发成功！`);
				successCount += validGroupedIds.length;
				
				// Handle replies / comments
				if (config.settings.comments?.enabled) {
					const commentCount = await forwardComments(msg, sourceEntity, destEntities, dropAuthor, client, config, addLog);
					successCount += commentCount;
				}
			} else {
				addLog("Warn", `[过滤跳过] 媒体组 [${groupedMessageIds.join(", ")}] 的所有成员均被规则过滤。`);
			}
			
			nextId = lookAheadId;
		} else {
			// 3. Single message
			const filterResult = shouldForwardMessage(msg, config);
			if (!filterResult.shouldForward) {
				addLog("Warn", `[过滤跳过] 单条消息 #${targetId} 被规则过滤（原因: ${filterResult.reason}）`);
			} else {
				for (const destEntity of destEntities) {
					await client.forwardMessages(destEntity, {
						messages: [targetId],
						fromPeer: sourceEntity,
						dropAuthor: dropAuthor
					});
				}
				
				const sneakPeek = msg.message ? ` "${msg.message.trim().substring(0, 25).replace(/\n/g, " ")}..."` : "";
				const msgTypeDesc = getMessageTypeDescription(msg);
				addLog("Success", `[${msgTypeDesc}] 单条消息 #${targetId}${sneakPeek} 转发成功！`);
				successCount++;
				
				if (config.settings.comments?.enabled) {
					const commentCount = await forwardComments(msg, sourceEntity, destEntities, dropAuthor, client, config, addLog);
					successCount += commentCount;
				}
			}
			nextId = targetId + 1;
		}
		
		res.json({
			success: true,
			empty: false,
			nextId,
			successCount,
			logs
		});
		
	} catch (err) {
		if (err.message.includes("MESSAGE_ID_INVALID")) {
			addLog("Warn", `消息 #${currentId} 类型或原频道不支持转发 (MESSAGE_ID_INVALID)，系统已自动跳过。`);
			return res.json({
				success: true,
				empty: true,
				nextId: parseInt(currentId, 10) + 1,
				logs
			});
		}
		addLog("Error", `处理消息 #${currentId} 失败: ${err.message}`);
		res.status(500).json({ error: err.message, logs });
	}
});

// Serve frontend SPA index.html static assets
app.use(express.static(path.join(__dirname, "public")));

// Fallback to SPA routing if needed
app.use((req, res) => {
	res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Start listening
app.listen(PORT, () => {
	writeLog(null, null, "Success", `网页交互端服务器已在端口 ${PORT} 启动！`);
	writeLog(null, null, "Info", `访问地址: http://localhost:${PORT}`);
	writeLog(null, null, "Info", `详细日志同时记录在: ${LOG_FILE}`);
});
