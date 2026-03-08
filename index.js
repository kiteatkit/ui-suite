import { getContext } from '/scripts/extensions.js';

const EXT_ID = 'ui-suite';

const BUTTON_ID = 'st_chat_nav_back_button';
const BUTTON_CONTAINER_ID = 'leftSendForm';
const CHAT_ROOT_SELECTOR = '#chat';
const CLOSE_CHAT_SELECTOR = '#options #option_close_chat';

const SELECTOR_PANEL = '#chat .welcomePanel';
const SELECTOR_ROOT = '.stStatsDashboard';
const HEATMAP_WEEKS = 52;
const HEATMAP_DAYS = HEATMAP_WEEKS * 7;
const RECENT_LIMIT = 4;
const CONTINUE_LIMIT = 2;

function onReady(fn) {
    if (typeof window.jQuery === 'function') {
        window.jQuery(fn);
    } else if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', fn, { once: true });
    } else {
        fn();
    }
}

function toSafeNumber(value) {
    if (typeof value === 'string') {
        const normalized = value.trim().replace(/\s+/g, '').replace(',', '.');
        const direct = Number(normalized);
        if (Number.isFinite(direct)) return direct;

        const digits = normalized.match(/-?\d+(?:\.\d+)?/);
        if (digits?.[0]) {
            const parsed = Number(digits[0]);
            if (Number.isFinite(parsed)) return parsed;
        }
    }

    const num = Number(value);
    return Number.isFinite(num) ? num : 0;
}

function getChatTimestampMs(chatItem, context = null) {
    const date = new Date(chatItem.last_mes);
    const ms = date.getTime();
    if (Number.isFinite(ms)) return ms;

    if (context?.timestampToMoment) {
        const m = context.timestampToMoment(chatItem.last_mes);
        if (m?.isValid?.()) return m.valueOf();
    }

    return 0;
}

function formatCompactNumber(value) {
    return new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(Math.max(0, value));
}

function formatSigned(value) {
    return value > 0 ? `+${value}` : `${value}`;
}

function formatRelativeTime(timestampMs) {
    if (!timestampMs) return 'Unknown';
    const hours = Math.max(1, Math.floor((Date.now() - timestampMs) / (1000 * 60 * 60)));
    if (hours < 24) return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
}

function filterChatsByPeriod(chats, period) {
    if (period === 'all') return chats;
    const days = period === 'week' ? 7 : 30;
    const cutoffMs = Date.now() - days * 24 * 60 * 60 * 1000;
    return chats.filter((x) => getChatTimestampMs(x) >= cutoffMs);
}

function aggregateUsage(chats) {
    let messages = 0;
    let tokens = 0;
    for (const chatItem of chats) {
        messages += toSafeNumber(chatItem.chat_items);
        tokens += toSafeNumber(chatItem.token_count ?? chatItem.total_tokens);
    }
    if (tokens <= 0 && messages > 0) {
        tokens = Math.round(messages * 42);
    }
    return { messages, tokens };
}

function buildModel(allChats, period) {
    const periodChats = filterChatsByPeriod(allChats, period);
    const weekCutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const prevWeekCutoff = Date.now() - 14 * 24 * 60 * 60 * 1000;
    const thisWeekChats = periodChats.filter((chatItem) => getChatTimestampMs(chatItem) >= weekCutoff);
    const prevWeekChats = periodChats.filter((chatItem) => {
        const ts = getChatTimestampMs(chatItem);
        return ts >= prevWeekCutoff && ts < weekCutoff;
    });

    const usage = aggregateUsage(periodChats);
    const usageThisWeek = aggregateUsage(thisWeekChats);
    const usagePrevWeek = aggregateUsage(prevWeekChats);

    const entityMap = new Map();
    for (const chatItem of periodChats) {
        const key = chatItem.is_group ? `group:${chatItem.group}` : `char:${chatItem.avatar}`;
        if (!entityMap.has(key)) {
            entityMap.set(key, {
                name: chatItem.char_name || 'Unknown',
                avatar: chatItem.char_thumbnail,
                messages: 0,
            });
        }
        entityMap.get(key).messages += toSafeNumber(chatItem.chat_items);
    }

    const topCharacters = Array.from(entityMap.values())
        .sort((a, b) => b.messages - a.messages)
        .slice(0, 4);

    const avgSessionMessages = periodChats.length ? usage.messages / periodChats.length : 0;
    const avgSessionMinutes = Math.round(avgSessionMessages * 0.6);
    const prevAvgSessionMinutes = prevWeekChats.length ? Math.round((usagePrevWeek.messages / prevWeekChats.length) * 0.6) : 0;

    const dayCounts = new Array(HEATMAP_DAYS).fill(0);
    const heatmapEnd = Date.now();
    const heatmapStart = heatmapEnd - (HEATMAP_DAYS - 1) * 24 * 60 * 60 * 1000;

    for (const chatItem of periodChats) {
        const timestamp = getChatTimestampMs(chatItem);
        if (!timestamp || timestamp < heatmapStart || timestamp > heatmapEnd) continue;
        const dayIndex = Math.floor((timestamp - heatmapStart) / (24 * 60 * 60 * 1000));
        if (dayIndex >= 0 && dayIndex < dayCounts.length) {
            dayCounts[dayIndex] += Math.max(1, toSafeNumber(chatItem.chat_items));
        }
    }

    const activeThisWeek = new Set(thisWeekChats.map((chatItem) => (chatItem.is_group ? `group:${chatItem.group}` : `char:${chatItem.avatar}`))).size;

    return {
        usage,
        usageThisWeek,
        usagePrevWeek,
        totalUniqueCharacters: entityMap.size,
        activeCharactersThisWeek: activeThisWeek,
        avgSessionMinutes: Math.max(0, avgSessionMinutes),
        prevAvgSessionMinutes,
        topCharacters,
        dayCounts,
    };
}

function dashboardTemplate() {
    return `
<div class="stStatsDashboard">
  <div class="stDashHeader">
    <div class="stDashTitle"><i class="fa-solid fa-chart-column"></i><span>Statistics</span></div>
    <select class="stDashPeriod text_pole" aria-label="Statistics period">
      <option value="all">All Time</option>
      <option value="month">Last 30 Days</option>
      <option value="week">Last 7 Days</option>
    </select>
  </div>

  <div class="stStatsRow">
    <div class="stStatCard" data-metric="messages"><div class="stStatLabel">Messages</div><div class="stStatValue">0</div><div class="stStatSub">0</div></div>
    <div class="stStatCard" data-metric="tokens"><div class="stStatLabel">Tokens</div><div class="stStatValue">0</div><div class="stStatSub">0</div></div>
    <div class="stStatCard" data-metric="characters"><div class="stStatLabel">Characters</div><div class="stStatValue">0</div><div class="stStatSub">0</div></div>
    <div class="stStatCard" data-metric="session"><div class="stStatLabel">Avg Session</div><div class="stStatValue">0m</div><div class="stStatSub">0</div></div>
  </div>

  <div class="stMiddleRow">
    <div class="stHeatmapSection">
      <div class="stSectionTitle">Activity</div>
      <div class="stHeatmapScroll"><div class="stHeatmapGrid"></div></div>
    </div>
    <div class="stTopSection">
      <div class="stSectionTitle">Top Characters</div>
      <div class="stTopList"></div>
    </div>
  </div>

  <div class="stBottomRow">
    <div class="stActivitySection">
      <div class="stSectionTitle">Recent Actions</div>
      <div class="stActivityList"></div>
    </div>
    <div class="stContinueSection">
      <div class="stSectionTitle">Continue</div>
      <div class="stContinueList"></div>
    </div>
  </div>
</div>`;
}

async function fetchAllChats(context) {
    const response = await fetch('/api/chats/recent', {
        method: 'POST',
        headers: context.getRequestHeaders(),
        body: JSON.stringify({ max: 10000, pinned: [] }),
        cache: 'no-cache',
    });

    if (!response.ok) return [];

    const data = await response.json();
    if (!Array.isArray(data)) return [];

    return data
        .map((chatItem) => {
            const character = context.characters.find((x) => x.avatar === chatItem.avatar);
            const group = context.groups.find((x) => x.id === chatItem.group);
            const ts = getChatTimestampMs(chatItem, context);
            const chatItems = Math.max(
                0,
                toSafeNumber(chatItem.chat_items),
                toSafeNumber(chatItem.message_count),
                toSafeNumber(chatItem.messages_count),
                toSafeNumber(chatItem.mes_count),
            );

            return {
                ...chatItem,
                chat_name: String(chatItem.file_name || '').replace('.jsonl', ''),
                chat_items: chatItems > 0 ? chatItems : 1,
                last_mes: chatItem.last_mes,
                mes: chatItem.mes || '',
                avatar: chatItem.avatar || '',
                group: chatItem.group || '',
                is_group: Boolean(group),
                char_name: character?.name || group?.name || 'Unknown',
                char_thumbnail: character ? context.getThumbnailUrl('avatar', character.avatar) : '/img/default-user.png',
                _timestamp: ts,
            };
        })
        .sort((a, b) => (b._timestamp || 0) - (a._timestamp || 0));
}

function collectChatsFromPanel(panel, context) {
    const rows = Array.from(panel.querySelectorAll('.welcomeAllPanel .recentChat, .welcomeRecentPanel .recentChat'));
    const result = [];

    rows.forEach((row, index) => {
        if (!(row instanceof HTMLElement)) return;
        const chatName = row.getAttribute('data-file') || '';
        const avatar = row.getAttribute('data-avatar') || '';
        const group = row.getAttribute('data-group') || '';
        const charName = row.querySelector('.characterName')?.textContent?.trim() || 'Unknown';
        const message = row.querySelector('.chatMessage')?.textContent?.trim() || '';
        const countText = row.querySelector('.chatStats .counterBlock small')?.textContent?.trim() || '0';
        const chatItems = toSafeNumber(countText);

        const dateTitle = row.querySelector('.chatDate')?.getAttribute('title') || '';
        let timestamp = 0;
        if (dateTitle && context?.timestampToMoment) {
            const m = context.timestampToMoment(dateTitle);
            if (m?.isValid?.()) timestamp = m.valueOf();
        }
        if (!timestamp) timestamp = Date.now() - index * 60 * 60 * 1000;

        const character = context.characters.find((x) => x.avatar === avatar);
        result.push({
            file_name: `${chatName}.jsonl`,
            chat_name: chatName,
            last_mes: new Date(timestamp).toISOString(),
            mes: message,
            chat_items: chatItems,
            avatar,
            group,
            is_group: Boolean(group),
            char_name: charName,
            char_thumbnail: character ? context.getThumbnailUrl('avatar', character.avatar) : '/img/default-user.png',
            _timestamp: timestamp,
        });
    });

    const deduped = new Map();
    for (const item of result) {
        const key = `${item.group ? `g:${item.group}` : `a:${item.avatar}`}::${item.chat_name}`;
        if (!deduped.has(key)) deduped.set(key, item);
    }

    return Array.from(deduped.values()).sort((a, b) => (b._timestamp || 0) - (a._timestamp || 0));
}

async function openChat(context, chatItem) {
    if (chatItem.is_group && chatItem.group) {
        await context.openGroupChat(chatItem.group, chatItem.chat_name);
        return;
    }

    if (!chatItem.avatar) return;

    const characterId = context.characters.findIndex((x) => x.avatar === chatItem.avatar);
    if (characterId < 0) return;

    await context.selectCharacterById(characterId);
    await context.openCharacterChat(chatItem.chat_name);
}

function renderHeatmap(grid, dayCounts) {
    grid.innerHTML = '';
    const maxCount = Math.max(0, ...dayCounts);

    for (let week = 0; week < HEATMAP_WEEKS; week++) {
        const col = document.createElement('div');
        col.className = 'stHeatmapCol';

        for (let day = 0; day < 7; day++) {
            const index = week * 7 + day;
            const value = dayCounts[index] ?? 0;
            const cell = document.createElement('div');
            cell.className = 'stHeatmapCell';

            let level = 0;
            if (maxCount > 0) {
                const ratio = value / maxCount;
                if (ratio > 0.75) level = 4;
                else if (ratio > 0.5) level = 3;
                else if (ratio > 0.25) level = 2;
                else if (ratio > 0) level = 1;
            }

            if (level > 0) cell.classList.add(`l${level}`);
            cell.title = `${value} messages`;
            col.append(cell);
        }

        grid.append(col);
    }
}

function renderStats(root, model) {
    root.querySelectorAll('.stStatCard').forEach((card) => {
        const metric = card.getAttribute('data-metric');
        const valueEl = card.querySelector('.stStatValue');
        const subEl = card.querySelector('.stStatSub');
        if (!(valueEl instanceof HTMLElement) || !(subEl instanceof HTMLElement)) return;

        if (metric === 'messages') {
            valueEl.textContent = formatCompactNumber(model.usage.messages);
            subEl.textContent = `${formatSigned(model.usageThisWeek.messages - model.usagePrevWeek.messages)} vs previous week`;
        } else if (metric === 'tokens') {
            valueEl.textContent = formatCompactNumber(model.usage.tokens);
            subEl.textContent = `${formatSigned(model.usageThisWeek.tokens - model.usagePrevWeek.tokens)} vs previous week`;
        } else if (metric === 'characters') {
            valueEl.textContent = `${model.totalUniqueCharacters}`;
            subEl.textContent = `${model.activeCharactersThisWeek} active this week`;
        } else if (metric === 'session') {
            valueEl.textContent = `${model.avgSessionMinutes}m`;
            subEl.textContent = `${formatSigned(model.avgSessionMinutes - model.prevAvgSessionMinutes)}m vs previous week`;
        }
    });
}

function renderTop(root, model) {
    const list = root.querySelector('.stTopList');
    if (!(list instanceof HTMLElement)) return;
    list.innerHTML = '';
    const maxMessages = Math.max(1, ...model.topCharacters.map((x) => x.messages));

    for (const [index, entry] of model.topCharacters.entries()) {
        const row = document.createElement('div');
        row.className = 'stTopRow';
        row.innerHTML = `
          <div class="stTopRank">${index + 1}</div>
          <div class="stTopAvatar"><img src="${entry.avatar}" alt="${entry.name}"></div>
          <div class="stTopInfo"><div class="stTopName">${entry.name}</div><div class="stTopMsgs">${formatCompactNumber(entry.messages)} messages</div></div>
          <div class="stTopBarWrap"><div class="stTopBar" style="width:${Math.max(8, Math.round((entry.messages / maxMessages) * 100))}%"></div></div>
        `;
        list.append(row);
    }
}

function renderActivity(root, recentChats) {
    const list = root.querySelector('.stActivityList');
    if (!(list instanceof HTMLElement)) return;
    list.innerHTML = '';

    for (const chatItem of recentChats.slice(0, RECENT_LIMIT)) {
        const type = toSafeNumber(chatItem.chat_items) <= 2 ? 'new' : 'chat';
        const text = type === 'new'
            ? `Chat started with ${chatItem.char_name}`
            : `Chat with ${chatItem.char_name} - ${toSafeNumber(chatItem.chat_items)} messages`;
        const row = document.createElement('div');
        row.className = 'stActivityItem';
        row.innerHTML = `<div class="stActivityDot ${type}"></div><div class="stActivityText">${text}</div><div class="stActivityTime">${formatRelativeTime(chatItem._timestamp)}</div>`;
        list.append(row);
    }
}

function renderContinue(root, recentChats, context) {
    const list = root.querySelector('.stContinueList');
    if (!(list instanceof HTMLElement)) return;
    list.innerHTML = '';

    for (const chatItem of recentChats.slice(0, CONTINUE_LIMIT)) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'stContinueCard';
        btn.innerHTML = `
          <div class="stContinueAvatar"><img src="${chatItem.char_thumbnail}" alt="${chatItem.char_name}"></div>
          <div class="stContinueInfo"><div class="stContinueName">${chatItem.char_name}</div><div class="stContinuePreview">${chatItem.mes || ''}</div></div>
          <div class="stContinueArrow"><i class="fa-solid fa-arrow-right"></i></div>
        `;
        btn.addEventListener('click', () => void openChat(context, chatItem));
        list.append(btn);
    }
}

async function renderIntoPanel(panel) {
    const context = getContext();
    let root = panel.querySelector(SELECTOR_ROOT);
    const isNewRoot = !(root instanceof HTMLElement);
    if (isNewRoot) {
        panel.insertAdjacentHTML('beforeend', dashboardTemplate());
        root = panel.querySelector(SELECTOR_ROOT);
    }
    if (!(root instanceof HTMLElement)) return;

    let allChats = await fetchAllChats(context);
    const domChats = collectChatsFromPanel(panel, context);
    if (!allChats.length || aggregateUsage(allChats).messages <= 0) {
        allChats = domChats;
    }
    if (!allChats.length) return;

    const periodSelect = root.querySelector('.stDashPeriod');
    const heatmapGrid = root.querySelector('.stHeatmapGrid');
    const heatmapScroll = root.querySelector('.stHeatmapScroll');
    if (!(periodSelect instanceof HTMLSelectElement) || !(heatmapGrid instanceof HTMLElement) || !(heatmapScroll instanceof HTMLElement)) {
        return;
    }

    const run = () => {
        try {
            const model = buildModel(allChats, periodSelect.value);
            renderStats(root, model);
            renderHeatmap(heatmapGrid, model.dayCounts);
            if (isNewRoot) {
                heatmapScroll.scrollLeft = heatmapScroll.scrollWidth;
            }
            renderTop(root, model);
            renderActivity(root, allChats);
            renderContinue(root, allChats, context);
        } catch (error) {
            console.error('[ui-suite] dashboard render error', error);
        }
    };

    periodSelect.onchange = run;
    run();
}

async function renderAllPanels() {
    const panels = Array.from(document.querySelectorAll(SELECTOR_PANEL));
    for (const panel of panels) {
        if (panel instanceof HTMLElement) {
            await renderIntoPanel(panel);
        }
    }
}

function patchWelcomePanel(panel) {
    if (!(panel instanceof HTMLElement)) return;

    panel.querySelectorAll('.showRecentChats, .hideRecentChats').forEach((el) => el.remove());
    panel.classList.remove('recentHidden');

    const recentTab = panel.querySelector('.welcomeTab[data-tab="recent"]');
    if (recentTab instanceof HTMLButtonElement) {
        recentTab.textContent = 'recent chats';
        recentTab.classList.remove('active');
    }
}

function patchAllPanels() {
    document.querySelectorAll('.welcomePanel').forEach((panel) => patchWelcomePanel(panel));
}

function isInsideChat() {
    const context = getContext();
    const inWelcomeScreen = Boolean(document.querySelector(`${CHAT_ROOT_SELECTOR} .welcomePanel`));
    if (inWelcomeScreen) return false;
    return context.characterId !== undefined || Boolean(context.groupId) || context.chat.length > 0;
}

function triggerCloseChat() {
    const closeButtons = Array.from(document.querySelectorAll(CLOSE_CHAT_SELECTOR));
    const closeButton = closeButtons.at(-1);

    if (!closeButton) {
        console.warn('[ui-suite] Close chat action was not found.');
        return;
    }

    closeButton.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
}

function ensureBackButton() {
    const host = document.getElementById(BUTTON_CONTAINER_ID);
    if (!host) return null;

    let button = document.getElementById(BUTTON_ID);
    if (button) return button;

    button = document.createElement('button');
    button.type = 'button';
    button.id = BUTTON_ID;
    button.className = 'interactable st_chat_nav_back_button menu_button_icon';
    button.title = 'Back to main screen';
    button.setAttribute('aria-label', 'Back to main screen');
    button.innerHTML = '<i class="fa-solid fa-arrow-left"></i>';
    button.addEventListener('click', triggerCloseChat);

    host.prepend(button);
    return button;
}

function renderBackButton() {
    const button = ensureBackButton();
    if (!button) return;
    button.classList.toggle('displayNone', !isInsideChat());
}

function initTheme() {
    document.body.classList.add('st-theme-starter');
}

function init() {
    const context = getContext();

    initTheme();
    patchAllPanels();
    void renderAllPanels();
    renderBackButton();

    const rerenderStats = () => void renderAllPanels();
    const rerenderBack = () => renderBackButton();

    context.eventSource.on(context.eventTypes.APP_READY, rerenderStats);
    context.eventSource.on(context.eventTypes.CHAT_CHANGED, () => {
        patchAllPanels();
        rerenderStats();
        rerenderBack();
    });
    context.eventSource.on(context.eventTypes.MESSAGE_RECEIVED, () => {
        rerenderStats();
        rerenderBack();
    });
    context.eventSource.on(context.eventTypes.MESSAGE_DELETED, () => {
        rerenderStats();
        rerenderBack();
    });

    const observer = new MutationObserver(() => {
        patchAllPanels();
        if (document.querySelector(SELECTOR_PANEL)) {
            void renderAllPanels();
        }
        renderBackButton();
    });
    observer.observe(document.body, { childList: true, subtree: true });

    setInterval(renderBackButton, 750);
    console.debug(`[${EXT_ID}] loaded`);
}

onReady(() => {
    try {
        init();
    } catch (error) {
        console.error(`[${EXT_ID}] initialization error`, error);
    }
});
