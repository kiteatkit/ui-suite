import { getContext } from '/scripts/extensions.js';

const EXT_ID = 'ui-suite';

const BUTTON_ID = 'st_chat_nav_back_button';
const BUTTON_CONTAINER_ID = 'leftSendForm';
const CHAT_ROOT_SELECTOR = '#chat';
const CLOSE_CHAT_SELECTOR = '#options #option_close_chat';

const SELECTOR_PANEL = '#chat .welcomePanel, #chat .welcomeScreen, #chat .welcome-page';
const SELECTOR_ROOT = '.stStatsDashboard';
const HEATMAP_WEEKS = 52;
const HEATMAP_DAYS = HEATMAP_WEEKS * 7;
const RECENT_LIMIT = 4;
const CONTINUE_LIMIT = 2;
const CHATS_CACHE_TTL_MS = 15000;
const ENABLE_DASHBOARD = true;
const ENABLE_OBSERVER = true;

let chatsCache = { ts: 0, data: [] };
let renderTimer = null;
let renderInFlight = false;
let patchTimer = null;
const SAFE_MODE = true;

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
    <div class="stDashActions">
      <button type="button" class="stDashRefresh menu_button menu_button_icon" title="Refresh stats" aria-label="Refresh stats"><i class="fa-solid fa-rotate-right"></i></button>
      <select class="stDashPeriod text_pole" aria-label="Statistics period">
        <option value="all">All Time</option>
        <option value="month">Last 30 Days</option>
        <option value="week">Last 7 Days</option>
      </select>
    </div>
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

async function fetchAllChats(context, force = false) {
    if (!force && Date.now() - chatsCache.ts < CHATS_CACHE_TTL_MS && Array.isArray(chatsCache.data) && chatsCache.data.length) {
        return chatsCache.data;
    }

    const response = await fetch('/api/chats/recent', {
        method: 'POST',
        headers: context.getRequestHeaders(),
        body: JSON.stringify({ max: 10000, pinned: [] }),
        cache: 'no-cache',
    });

    if (!response.ok) return [];

    const data = await response.json();
    if (!Array.isArray(data)) return [];

    const mapped = data
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

    chatsCache = { ts: Date.now(), data: mapped };
    return mapped;
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

async function renderIntoPanel(panel, force = false) {
    const context = getContext();
    let root = panel.querySelector(SELECTOR_ROOT);
    const isNewRoot = !(root instanceof HTMLElement);
    if (isNewRoot) {
        panel.insertAdjacentHTML('beforeend', dashboardTemplate());
        root = panel.querySelector(SELECTOR_ROOT);
    }
    if (!(root instanceof HTMLElement)) return;
    if (!isNewRoot && !force && root.dataset.initialized === '1') return;

    let allChats = await fetchAllChats(context, force);
    const domChats = collectChatsFromPanel(panel, context);
    if (!allChats.length || aggregateUsage(allChats).messages <= 0) {
        allChats = domChats;
    }
    if (!allChats.length) return;

    const periodSelect = root.querySelector('.stDashPeriod');
    const refreshButton = root.querySelector('.stDashRefresh');
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

    if (!periodSelect.dataset.bound) {
        periodSelect.onchange = run;
        periodSelect.dataset.bound = '1';
    }
    if (refreshButton instanceof HTMLButtonElement && !refreshButton.dataset.bound) {
        refreshButton.addEventListener('click', () => {
            chatsCache.ts = 0;
            void renderIntoPanel(panel, true);
        });
        refreshButton.dataset.bound = '1';
    }
    run();
    root.dataset.initialized = '1';
}

async function renderAllPanels(force = false) {
    if (renderInFlight) return;
    renderInFlight = true;
    const panels = Array.from(document.querySelectorAll(SELECTOR_PANEL));
    try {
        for (const panel of panels) {
            if (panel instanceof HTMLElement) {
                await renderIntoPanel(panel, force);
            }
        }
    } finally {
        renderInFlight = false;
    }
}

function scheduleRender(force = false) {
    if (renderTimer) {
        clearTimeout(renderTimer);
    }
    renderTimer = setTimeout(() => {
        void renderAllPanels(force);
    }, 120);
}

function patchWelcomePanel(panel) {
    if (!(panel instanceof HTMLElement)) return;

    panel.querySelectorAll('.showRecentChats, .hideRecentChats').forEach((el) => el.remove());
    panel.classList.remove('recentHidden');
    panel.classList.add('activeAllChats');

    ensureWelcomeControls(panel);
    bindWelcomeTabs(panel);

    if (typeof window.accountStorage?.setItem === 'function') {
        window.accountStorage.setItem('WelcomePage_ActiveTab', 'all');
    }

    groupAllChatsByCharacter(panel);
    bindAllChatsGroupToggles(panel);
}

function patchAllPanels() {
    const panels = Array.from(document.querySelectorAll(SELECTOR_PANEL));
    panels.forEach((panel) => {
        if (panel instanceof HTMLElement) {
            patchWelcomePanel(panel);
        }
    });

    // Fallback for versions where class names changed but recent chat cards are still present.
    if (!panels.length) {
        const chatRoot = document.querySelector(CHAT_ROOT_SELECTOR);
        if (!(chatRoot instanceof HTMLElement)) return;
        const lists = Array.from(chatRoot.querySelectorAll('.recentChatList, .recentChatsList'));
        const fallbackList = lists.find((el) => el.querySelector('.recentChat'));
        const fallbackPanel = fallbackList?.closest('div');
        if (fallbackPanel instanceof HTMLElement) {
            patchWelcomePanel(fallbackPanel);
        }
    }
}

function getStorageApi() {
    if (window.accountStorage && typeof window.accountStorage.getItem === 'function' && typeof window.accountStorage.setItem === 'function') {
        return window.accountStorage;
    }
    return window.localStorage;
}

function ensureWelcomeControls(panel) {
    const header = panel.querySelector('.recentChatsTitle, .welcomeRecentTitle, .welcomeChatsTitle');
    if (!(header instanceof HTMLElement)) return;

    let recentTab = header.querySelector('.welcomeTab[data-tab="recent"]');
    let allTab = header.querySelector('.welcomeTab[data-tab="all"]');

    if (!(recentTab instanceof HTMLButtonElement)) {
        recentTab = document.createElement('button');
        recentTab.type = 'button';
        recentTab.className = 'menu_button welcomeTab';
        recentTab.setAttribute('data-tab', 'recent');
        header.prepend(recentTab);
    }
    recentTab.textContent = 'recent chats';

    if (!(allTab instanceof HTMLButtonElement)) {
        allTab = document.createElement('button');
        allTab.type = 'button';
        allTab.className = 'menu_button welcomeTab';
        allTab.setAttribute('data-tab', 'all');
        allTab.textContent = 'All Chats';
        recentTab.insertAdjacentElement('afterend', allTab);
    }

    const headerWrap = panel.querySelector('.welcomeHeader, .welcomeTopRow, .welcomeHeaderRow');
    if (headerWrap instanceof HTMLElement && !headerWrap.querySelector('.welcomeSearchWrap')) {
        const searchWrap = document.createElement('div');
        searchWrap.className = 'welcomeSearchWrap';
        searchWrap.innerHTML = '<input class="text_pole welcomeChatSearch" type="text" autocomplete="off" placeholder="Search chats...">';
        const shortcuts = headerWrap.querySelector('.welcomeShortcuts');
        if (shortcuts) shortcuts.insertAdjacentElement('beforebegin', searchWrap);
        else headerWrap.append(searchWrap);
    }

    const recentPanel = panel.querySelector('.welcomeRecentPanel, .welcomeRecent, .recentChatsPanel, .welcomeChatsPanel');
    if (recentPanel instanceof HTMLElement) {
        recentPanel.classList.add('welcomeRecentPanel', 'welcomeTabPanel');
    }

    let allPanel = panel.querySelector('.welcomeAllPanel, .allChatsPanel');
    if (!(allPanel instanceof HTMLElement) && recentPanel instanceof HTMLElement) {
        allPanel = document.createElement('div');
        allPanel.className = 'welcomeRecent welcomeTabPanel welcomeAllPanel';
        allPanel.innerHTML = '<div class="recentChatList allChatList"></div>';
        recentPanel.insertAdjacentElement('afterend', allPanel);
    }
}

function bindWelcomeTabs(panel) {
    const storage = getStorageApi();
    const activeTabKey = 'WelcomePage_ActiveTab';
    const tabs = panel.querySelectorAll('.welcomeTab');
    tabs.forEach((tab) => {
        if (!(tab instanceof HTMLButtonElement) || tab.dataset.bound === '1') return;
        tab.addEventListener('click', () => {
            const tabName = tab.getAttribute('data-tab');
            const isAllTab = tabName === 'all';
            panel.classList.toggle('activeAllChats', isAllTab);
            storage.setItem(activeTabKey, isAllTab ? 'all' : 'recent');
        });
        tab.dataset.bound = '1';
    });

    const savedTab = storage.getItem(activeTabKey);
    panel.classList.toggle('activeAllChats', savedTab === 'all');

    const searchInput = panel.querySelector('.welcomeChatSearch, .welcomeSearchInput, .chatSearchInput');
    if (searchInput instanceof HTMLInputElement && searchInput.dataset.bound !== '1') {
        searchInput.addEventListener('input', () => {
            const query = searchInput.value.trim().toLowerCase();
            const items = Array.from(panel.querySelectorAll('.recentChat'));

            items.forEach((item) => {
                const text = (item.textContent || '').toLowerCase();
                item.classList.toggle('searchHidden', query.length > 0 && !text.includes(query));
            });

            const groupedLists = Array.from(panel.querySelectorAll('.allChatsCharacterGroup'));
            groupedLists.forEach((groupElement) => {
                const visibleItems = groupElement.querySelectorAll('.recentChat:not(.searchHidden)');
                groupElement.classList.toggle('searchHidden', visibleItems.length === 0);
            });
        });
        searchInput.dataset.bound = '1';
    }
}

function bindAllChatsGroupToggles(panel) {
    const storage = getStorageApi();
    const key = 'WelcomePage_AllChatsCollapsedGroups';
    panel.querySelectorAll('.toggleAllChatsGroup, .toggleChatsGroup').forEach((toggleButton) => {
        if (!(toggleButton instanceof HTMLButtonElement) || toggleButton.dataset.bound === '1') return;
        toggleButton.addEventListener('click', (event) => {
            event.stopPropagation();
            const groupElement = toggleButton.closest('.allChatsCharacterGroup');
            const entityId = groupElement?.getAttribute('data-entity-id');
            if (!(groupElement instanceof HTMLElement) || !entityId) return;

            const isCollapsed = groupElement.classList.toggle('collapsed');
            const current = new Set(JSON.parse(storage.getItem(key) || '[]'));
            if (isCollapsed) current.add(entityId);
            else current.delete(entityId);
            storage.setItem(key, JSON.stringify(Array.from(current)));
        });
        toggleButton.dataset.bound = '1';
    });
}

function groupAllChatsByCharacter(panel) {
    const storage = getStorageApi();
    const collapsedGroupsKey = 'WelcomePage_AllChatsCollapsedGroups';
    const allList = panel.querySelector('.welcomeAllPanel .allChatList, .welcomeAllPanel .recentChatList, .allChatsPanel .allChatList, .allChatsPanel .recentChatList');
    if (!(allList instanceof HTMLElement)) return;

    // If grouped markup already exists, just apply persisted collapse state.
    const existingGroups = Array.from(allList.querySelectorAll(':scope > .allChatsCharacterGroup'));
    if (existingGroups.length > 0) {
        const collapsed = new Set(JSON.parse(storage.getItem(collapsedGroupsKey) || '[]'));
        existingGroups.forEach((group) => {
            const id = group.getAttribute('data-entity-id');
            if (id && collapsed.has(id)) group.classList.add('collapsed');
        });
        return;
    }

    let chats = Array.from(allList.querySelectorAll(':scope > .recentChat'));
    if (!chats.length) {
        const recentList = panel.querySelector('.welcomeRecentPanel .recentChatList, .welcomeRecent .recentChatList, .recentChatsPanel .recentChatList, .welcomeChatsPanel .recentChatList');
        if (recentList instanceof HTMLElement) {
            const sourceChats = Array.from(recentList.querySelectorAll(':scope > .recentChat'));
            sourceChats.forEach((chat) => {
                if (!(chat instanceof HTMLElement)) return;
                allList.append(chat.cloneNode(true));
            });
            chats = Array.from(allList.querySelectorAll(':scope > .recentChat'));
        }
    }
    if (!chats.length) return;

    const groupsMap = new Map();
    chats.forEach((chat) => {
        if (!(chat instanceof HTMLElement)) return;
        const groupId = chat.getAttribute('data-group') || '';
        const avatarId = chat.getAttribute('data-avatar') || '';
        const entityId = groupId ? `group:${groupId}` : `char:${avatarId}`;
        const entityName = (chat.querySelector('.characterName')?.textContent || 'Unknown').trim() || 'Unknown';

        if (!groupsMap.has(entityId)) {
            groupsMap.set(entityId, { entityId, entityName, chats: [] });
        }
        groupsMap.get(entityId).chats.push(chat);
    });

    const sortedGroups = Array.from(groupsMap.values()).sort((a, b) => a.entityName.localeCompare(b.entityName));
    const fragment = document.createDocumentFragment();
    const collapsed = new Set(JSON.parse(storage.getItem(collapsedGroupsKey) || '[]'));

    sortedGroups.forEach((groupData) => {
        const groupElement = document.createElement('div');
        groupElement.className = 'allChatsCharacterGroup';
        groupElement.setAttribute('data-entity-id', groupData.entityId);

        if (collapsed.has(groupData.entityId)) {
            groupElement.classList.add('collapsed');
        }

        const header = document.createElement('div');
        header.className = 'allChatsCharacterHeader';
        header.innerHTML = `
            <button class="menu_button menu_button_icon toggleAllChatsGroup" title="Collapse/expand chats" aria-label="Collapse/expand chats">
                <i class="fa-solid fa-chevron-down fa-fw"></i>
            </button>
            <span></span>
            <small></small>
        `;

        const titleEl = header.querySelector('span');
        const countEl = header.querySelector('small');
        if (titleEl) titleEl.textContent = groupData.entityName;
        if (countEl) countEl.textContent = String(groupData.chats.length);

        groupElement.append(header);
        groupData.chats.forEach((chat) => groupElement.append(chat));
        fragment.append(groupElement);
    });

    allList.innerHTML = '';
    allList.append(fragment);
}

function isInsideChat() {
    let context;
    try {
        context = getContext();
    } catch {
        return false;
    }
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
    let context = null;
    try {
        context = getContext();
    } catch (error) {
        console.error('[ui-suite] getContext failed', error);
    }
    initTheme();
    patchAllPanels();
    renderBackButton();

    if (ENABLE_DASHBOARD) {
        scheduleRender(true);
    }

    if (context?.eventSource && context?.eventTypes) {
        context.eventSource.on(context.eventTypes.APP_READY, () => {
            if (ENABLE_DASHBOARD) {
                scheduleRender(true);
            }
        });
        context.eventSource.on(context.eventTypes.CHAT_CHANGED, () => {
            patchAllPanels();
            if (ENABLE_DASHBOARD) {
                scheduleRender(false);
            }
            renderBackButton();
        });
        context.eventSource.on(context.eventTypes.MESSAGE_RECEIVED, () => {
            renderBackButton();
        });
        context.eventSource.on(context.eventTypes.MESSAGE_DELETED, () => {
            renderBackButton();
        });
    }

    if (ENABLE_OBSERVER) {
        const chatRoot = document.querySelector(CHAT_ROOT_SELECTOR);
        if (chatRoot instanceof HTMLElement) {
            const observer = new MutationObserver(() => {
                if (patchTimer) {
                    clearTimeout(patchTimer);
                }
                patchTimer = setTimeout(() => {
                    const panel = chatRoot.querySelector('.welcomePanel');
                    if (panel instanceof HTMLElement) {
                        patchWelcomePanel(panel);
                        if (ENABLE_DASHBOARD) scheduleRender(false);
                    }
                    renderBackButton();
                }, 80);
            });
            observer.observe(chatRoot, { childList: true, subtree: true });
        }
    }

    console.debug(`[${EXT_ID}] loaded`);
}

onReady(() => {
    try {
        init();
    } catch (error) {
        console.error(`[${EXT_ID}] initialization error`, error);
    }
});
