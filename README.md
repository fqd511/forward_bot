# Telegram Forward Bot

A lightweight and efficient solution for forwarding and filtering Telegram messages, supporting both **interactive CLI (Userbot)** and **daemon service (Bot)** modes.

---

## 🛠️ Modes of Operation

### 1. Interactive CLI Mode (Core Feature ✨)
*   **Script**: `forward-cli.js` (Run via: `npm run forward`)
*   **Mechanism**: Uses **Userbot (GramJS)** to fetch, filter, and forward messages.
*   **Key Features**:
    *   **Bypasses Bot Restrictions**: Works on private, restricted, or copyrighted channels where standard bots fail.
    *   **Media Group Merging**: Groups pictures/videos together in a single post instead of splitting them.
    *   **Advanced Filtering**: Supports text regex filters (include/exclude) and 8 distinct media type filters.
    *   **Multi-Account Switcher**: Log in and save multiple user sessions. Easily choose which account to use upon startup.
    *   **Anti-Ban Jitter**: Adds a randomized human-like delay (jitter) between forwards to protect your account.
    *   **Custom Range**: Set a starting link and an optional ending link (runs until the latest message if left empty).

### 2. Daemon Service Mode (Under Development 🚧)
*   **Script**: `index.js` (Run via: `npm run dev`)
*   **Mechanism**: Uses **Bot API (Telegraf)** to forward messages automatically on incoming events.

---

## 🚀 Getting Started (CLI Mode)

1.  **Configure environment**:
    *   Create a `.env` file from `.env.sample`.
    *   Fill in `DEST_CHANNEL`, your `API_ID`, and `API_HASH` (get them for free from [my.telegram.org](https://my.telegram.org)).
    *   Set up `TELEGRAM_PROXY` (Socks5, e.g., `socks5://127.0.0.1:7890`) if you need a proxy.

2.  **Configure filters**:
    *   Modify `forward-config.json` to customize regex blacklists/whitelists, media restrictions, or default delay. Detail examples are included inside the configuration file.

3.  **Run the script**:
    ```bash
    npm run forward
    ```
    *   Choose an existing account from the list or log in to a new one.
    *   Enter the starting message link and optionally the ending link to begin forwarding.

---

## 📂 Project Structure
*   `forward-cli.js` — Core CLI interactive script.
*   `forward-config.json` — Filters, delay, and origin-hiding settings.
*   `index.js` — Daemon service entry point (under dev).
*   `.sessions/` — Directory containing saved logins (auto-gitignored for safety).
