/**
 * dsh-model-balance-panel —— 宿主半侧（Host）。
 *
 * 职责只有一件事：把「DSH 里配置了哪些模型服务商 / 各服务商账户还剩多少」查出来，
 * 以 JSON 交给浏览器半侧。页面只渲染，不直接访问任何外部接口，也不接触凭证。
 *
 * 数据来源分两层，都来自 DSH 自己：
 *   1. 服务商与模型清单：`ctx.llm.listProviders()`（已注册的实时路由）/
 *      `ctx.llm.listConfigurableProviders()`（适配器声明可配置的路由，注册表为空时兜底）/
 *      `ctx.llm.listModels(provider)`；当前在用模型取自 `agentDefaultModel.currentSelection()`。
 *      这与宿主模型选择器同源，所以本面板不会出现「DSH 里没有的模型」。
 *   2. 余额：各服务商自己的账户/用量接口（见 PROVIDERS）。凭证一律经 `ctx.credentials.resolve`
 *      解析后只用于这一次请求，绝不回传、不落盘、不进响应。
 *
 * 失败口径（贯穿全文）：只上报接口真实给过的数字。HTTP 非 2xx、字段缺失/非法一律落成
 * `status: 'error'` 或 `credential-missing`，**绝不伪造 0 余额** —— 0 只能来自接口本身。
 *
 * 路由：
 *   GET /dsh-model-balance-panel/snapshot          → 一次完整快照（5 秒内复用，避免连点打爆上游）
 *   GET /dsh-model-balance-panel/snapshot?force=1  → 强制刷新（面板上的「刷新」按钮）
 */

/** 插件名（cordis 插件名，也是客户端本地化命名空间） */
export const name = 'model-balance-panel';

/** 硬依赖：没有 HTTP 载体就没有数据出口；没有 llm 服务就列不出模型 */
export const inject = ['webServer', 'llm'];

/** 本插件独占的路由前缀（与其它插件的路由不重叠） */
const ROUTE_PREFIX = '/dsh-model-balance-panel';
const SNAPSHOT_PATH = ROUTE_PREFIX + '/snapshot';

/** 单次上游请求超时 */
const UPSTREAM_TIMEOUT_MS = 20_000;
/** 上游失败后的重试次数（境外接口偶发超时，实测重试有效） */
const UPSTREAM_RETRIES = 2;
/** 重试间隔 */
const RETRY_DELAY_MS = 800;
/** 快照最短复用时间：进入页面会刷新，连点刷新按钮不该重复打上游 */
const MIN_REFRESH_MS = 5_000;
/** 列模型的上限等待：模型清单只是展示用，不能拖住余额 */
const MODEL_LIST_TIMEOUT_MS = 8_000;

// ---------------------------------------------------------------------------
// 响应校验工具：必填字段缺失/非法一律抛错（调用方落成 error），不静默当 0
// ---------------------------------------------------------------------------

/** 取普通对象：数组、null、标量都算「不是对象」 */
function obj(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
}

/** 必填数字：非有限数抛错 */
function num(value, what) {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error('余额数据字段非法：' + what);
  return n;
}

/** 必填非空字符串 */
function str(value, what) {
  if (typeof value !== 'string' || value.length === 0) throw new Error('余额数据字段非法：' + what);
  return value;
}

/** 可选数字：缺失、空串、非法都当作「没有这个值」 */
function looseNum(value) {
  if (value === undefined || value === null || value === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * 重置时间 → ISO 字符串。
 * 字符串原样收；数字时间戳按秒/毫秒自动识别；0 / 负数 / 非法都当作「没有重置时间」
 * （真实报文里空闲窗口是 `resetAt: 0` 的占位值，不是 1970 年）。
 */
function resetTime(value) {
  if (typeof value === 'string') return value.length > 0 ? value : undefined;
  const n = looseNum(value);
  if (n === undefined || n <= 0) return undefined;
  const ms = n < 1_000_000_000_000 ? n * 1000 : n;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

/**
 * 一个限额窗口 `{ used, cap, resetAt }` → `{ percent, capUsd, resetsAt }`。
 * 形态不认识（缺 used/cap 或 cap <= 0）→ undefined，即「该服务商没有这个窗口」，
 * 而不是 0%。下界取 0（负用量按未消耗读），上界不夹 —— 超额时如实报 > 100%。
 */
function readWindow(value) {
  const window = obj(value);
  if (!window) return undefined;
  const used = looseNum(window.used);
  const cap = looseNum(window.cap);
  if (used === undefined || cap === undefined || cap <= 0) return undefined;
  const percent = Math.max(0, (used / cap) * 100);
  const resetsAt = resetTime(window.resetAt);
  return resetsAt === undefined ? { percent, capUsd: cap } : { percent, capUsd: cap, resetsAt };
}

/** 金额串 → 两位小数字符串（不重算总和，只收敛精度） */
function money(value, what) {
  const raw = str(value, what);
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error('余额数据字段非法：' + what);
  return n.toFixed(2);
}

/** 两个金额串相加（按分相加，避免浮点误差显形） */
function sumMoney(a, b) {
  return ((Math.round(Number(a) * 100) + Math.round(Number(b) * 100)) / 100).toFixed(2);
}

/** 只带出现过的查询参数 */
function queryString(params) {
  const pairs = Object.entries(params).filter(([, value]) => value !== undefined);
  if (pairs.length === 0) return '';
  return '?' + pairs.map(([key, value]) => key + '=' + encodeURIComponent(value)).join('&');
}

/**
 * 抓一个 JSON 上游：Bearer + 超时 + 重试。
 * 非 2xx 直接抛错（调用方决定落成什么状态），并把响应体截断后附进错误，方便自查。
 */
async function fetchJson(url, key, label) {
  let last;
  for (let attempt = 0; attempt <= UPSTREAM_RETRIES; attempt++) {
    try {
      const res = await fetch(url, {
        headers: {
          Authorization: 'Bearer ' + key,
          Accept: 'application/json',
          'User-Agent': 'dsh-model-balance-panel',
        },
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      });
      if (!res.ok) {
        let detail = '';
        try {
          detail = (await res.text()).slice(0, 200);
        } catch {
          /* 读不出响应体也不影响判失败 */
        }
        throw new Error(`${label} HTTP ${res.status}${detail ? ' · ' + detail : ''}`);
      }
      return await res.json();
    } catch (error) {
      last = error;
      if (attempt < UPSTREAM_RETRIES) await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
    }
  }
  throw last instanceof Error ? last : new Error(String(last));
}

// ---------------------------------------------------------------------------
// 服务商余额来源
//
// 一个服务商 = 一条定义：能命中的 provider id + 凭证引用（或「没有 API Key」）+ 取数函数。
// 取数函数只负责成功路径；任何失败都抛错，由 describeProvider 统一翻译成状态。
// 加一个服务商 = 在 PROVIDERS 里加一条，客户端不用动。
// ---------------------------------------------------------------------------

/** OpenCode Go 三个窗口的满额度金额（USD）。业务常量：接口只回报百分比，不回报额度。 */
const OPENCODE_GO_QUOTA_USD = { rolling: 12, weekly: 30, monthly: 60 };

/** Command Code 控制面基址（`/alpha/*` 固定在根域名，与推理数据面不是同一条路径） */
const COMMANDCODE_API_BASE = 'https://api.commandcode.ai';

const PROVIDERS = [
  {
    /** provider id（与 DSH 模型选择器里的 id 一致） */
    ids: ['opencode-go'],
    /** 凭证引用名：由 ctx.credentials.resolve 解析（就是配置里的 apiKeyEnv） */
    credentialRef: 'OPENCODE_GO_API_KEY',
    /**
     * OpenCode Go：三窗口用量。
     * `GET https://opencode.ai/zen/go/v1/usage` → `{ usage: { rolling, weekly, monthly } }`。
     * 三窗与三窗的重置时间都保证存在，缺一个就说明响应形态变了 → 抛错，不静默。
     */
    async fetch({ key }) {
      const body = await fetchJson('https://opencode.ai/zen/go/v1/usage', key, 'opencode usage');
      const usage = obj(obj(body)?.usage);
      if (!usage) throw new Error('opencode usage 响应缺少 usage');
      const rolling = obj(usage.rolling);
      const weekly = obj(usage.weekly);
      const monthly = obj(usage.monthly);
      if (!rolling || !weekly || !monthly) throw new Error('opencode usage 响应缺少窗口');
      return {
        shape: 'windows',
        windows: {
          rolling: {
            label: '5h',
            percent: num(rolling.percent, 'rolling.percent'),
            capUsd: OPENCODE_GO_QUOTA_USD.rolling,
            resetsAt: resetTime(rolling.resetsAt),
          },
          weekly: {
            percent: num(weekly.percent, 'weekly.percent'),
            capUsd: OPENCODE_GO_QUOTA_USD.weekly,
            resetsAt: resetTime(weekly.resetsAt),
          },
          monthly: {
            percent: num(monthly.percent, 'monthly.percent'),
            capUsd: OPENCODE_GO_QUOTA_USD.monthly,
            resetsAt: resetTime(monthly.resetsAt),
          },
        },
      };
    },
  },
  {
    /**
     * Command Code：额度 + 订阅 + 当期消耗，走控制面（官方 CLI 正在用的未文档化路由），
     * 串行 4 次调用。展示形态与 opencode 相同（三窗口），缺窗口时只是没有那一行。
     */
    ids: ['commandcode'],
    credentialRef: 'COMMANDCODE_API_KEY',
    async fetch({ key }) {
      const whoami = obj(
        await fetchJson(COMMANDCODE_API_BASE + '/alpha/whoami' + queryString({ limits: '1' }), key, 'commandcode /alpha/whoami'),
      );
      const org = obj(whoami?.org);
      const orgId = typeof org?.id === 'string' && org.id.length > 0 ? org.id : undefined;

      const creditsBody = await fetchJson(
        COMMANDCODE_API_BASE + '/alpha/billing/credits' + queryString({ orgId }),
        key,
        'commandcode /alpha/billing/credits',
      );
      const credits = obj(obj(creditsBody)?.credits);
      if (!credits) throw new Error('commandcode 响应缺少 credits');
      const creditFields = [credits.monthlyCredits, credits.purchasedCredits, credits.freeCredits];
      if (creditFields.every((value) => looseNum(value) === undefined)) {
        throw new Error('commandcode 响应缺少额度字段');
      }
      const remaining = creditFields.reduce((sum, value) => sum + Math.max(0, looseNum(value) ?? 0), 0);

      // 订阅是可选接口：按量付费账号可能没有订阅（非 2xx），此时只是缺月度重置时间
      let subscription;
      try {
        subscription = await fetchJson(
          COMMANDCODE_API_BASE + '/alpha/billing/subscriptions' + queryString({ orgId }),
          key,
          'commandcode /alpha/billing/subscriptions',
        );
      } catch {
        subscription = undefined;
      }
      const periodStart = obj(obj(subscription)?.data)?.currentPeriodStart;
      const summaryBody = await fetchJson(
        COMMANDCODE_API_BASE +
          '/alpha/usage/summary' +
          queryString({ since: typeof periodStart === 'string' ? periodStart : undefined, orgId }),
        key,
        'commandcode /alpha/usage/summary',
      );
      const spend = obj(summaryBody)?.totalCost;
      if (spend === undefined || spend === null) throw new Error('commandcode 响应缺少 totalCost');
      const spent = Math.max(0, num(spend, 'totalCost'));

      // 月度百分比 = 已消耗 /（已消耗 + 剩余）；分母为 0 时没有可报的比例
      const pool = spent + remaining;
      const windows = {};
      if (pool > 0) windows.monthly = { percent: (spent / pool) * 100, capUsd: pool };
      const periodEnd = obj(obj(subscription)?.data)?.currentPeriodEnd;
      if (windows.monthly && typeof periodEnd === 'string' && periodEnd.length > 0) {
        windows.monthly.resetsAt = periodEnd;
      }

      // windowLimits 实测与 credits 同级，同时兼容嵌在 credits 内的变体
      const limits = obj(obj(creditsBody)?.windowLimits) ?? obj(credits.windowLimits);
      if (limits?.limited === true) {
        const fiveHour = readWindow(limits.fiveHour);
        if (fiveHour) windows.rolling = { ...fiveHour, label: '5h' };
        const weekly = readWindow(limits.weekly);
        if (weekly) windows.weekly = weekly;
      }

      return { shape: 'windows', windows };
    },
  },
  {
    /**
     * DeepSeek 官方 API Key：账户金额，接口原样透传三个金额
     * （不按「赠送 + 充值」自己重算 total_balance —— 官方给的数字更可信）。
     */
    ids: ['deepseek-official', 'deepseek'],
    credentialRef: 'DEEPSEEK_API_KEY',
    async fetch({ key }) {
      const body = await fetchJson('https://api.deepseek.com/user/balance', key, 'deepseek balance');
      const infos = obj(body)?.balance_infos;
      if (!Array.isArray(infos) || infos.length === 0) throw new Error('deepseek balance 响应缺少 balance_infos');
      const first = obj(infos[0]);
      if (!first) throw new Error('deepseek balance 响应结构非法');
      return {
        shape: 'money',
        money: {
          currency: str(first.currency, 'currency'),
          total: str(first.total_balance, 'total_balance'),
          granted: str(first.granted_balance, 'granted_balance'),
          toppedUp: str(first.topped_up_balance, 'topped_up_balance'),
        },
      };
    },
  },
  {
    /**
     * DSH 账号路由（免费额度 / 平台登录）：没有 API Key，凭证是账号服务持有的授权记录，
     * 只能经 `ctx.deepseekAccount.getBalance()` 查询，因此不发任何 HTTP。
     */
    ids: ['deepseek-account'],
    credentialRef: null,
    async fetch({ resolveAccount }) {
      if (!resolveAccount) throw new Error('缺少账号服务（deepseekAccount）');
      const snapshot = await resolveAccount();
      if (!snapshot) throw new Error('账号未登录');
      if (snapshot.status !== 'ready') throw new Error('账号余额查询失败');
      const wallets = Array.isArray(snapshot.value) ? snapshot.value : [];
      const first = wallets.length > 0 ? obj(wallets[0]) : undefined;
      if (!first) throw new Error('账号没有可展示的钱包余额');
      const currency = typeof first.currency === 'string' && first.currency.length > 0 ? first.currency : 'CNY';
      const toppedUp = money(first.balance, 'balance');
      const bonus = (Array.isArray(snapshot.bonusWallets) ? snapshot.bonusWallets : [])
        .map((wallet) => obj(wallet))
        .find((wallet) => wallet !== undefined && wallet.currency === currency);
      const granted = bonus ? money(bonus.balance, 'bonus balance') : '0.00';
      return {
        shape: 'money',
        money: { currency, total: sumMoney(granted, toppedUp), granted, toppedUp },
      };
    },
  },
];

/** provider id → 定义（未登记 = 该服务商没有可查的余额接口） */
function findProvider(id) {
  return PROVIDERS.find((entry) => entry.ids.includes(id));
}

/**
 * 展示名：适配器有时直接把 provider id 当名字（如 opencode-go），
 * 这里给已知服务商补一个人读的名字；未登记的 id 原样显示。
 */
const DISPLAY_NAMES = {
  'opencode-go': 'OpenCode Go',
  commandcode: 'Command Code',
  'deepseek-official': 'DeepSeek',
};

/** 服务商在卡片上的标题：显式 displayName 优先，其次已知名字，最后 id */
function providerTitle(provider) {
  return provider.name && provider.name !== provider.id ? provider.name : DISPLAY_NAMES[provider.id] || provider.name || provider.id;
}

// ---------------------------------------------------------------------------
// DSH 服务读取（可选服务一律软取，不放进 inject）
// ---------------------------------------------------------------------------

/** 软取一个服务：服务不在场时返回 undefined，而不是抛错 */
function optionalService(ctx, name) {
  try {
    const service = typeof ctx.get === 'function' ? ctx.get(name) : undefined;
    return service || undefined;
  } catch {
    return undefined;
  }
}

/** 账号服务要求的调用方身份（只影响请求来源标识与平台侧文案，不参与金额） */
function accountClientMetadata() {
  return {
    version: '0.1.0',
    locale: 'zh-CN',
    timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
  };
}

/**
 * 凭证引用 → 明文 key。先问 DSH 凭证服务（就是配置里的 apiKeyEnv 解析路径），
 * 服务缺席或没有值时回落到进程环境变量；两处都没有 → undefined（= 未配置）。
 */
async function resolveCredential(ctx, ref) {
  const credentials = optionalService(ctx, 'credentials');
  if (credentials && typeof credentials.resolve === 'function') {
    try {
      const resolved = await credentials.resolve(ref);
      const value = resolved && typeof resolved.value === 'string' ? resolved.value : undefined;
      if (value && value.length > 0) return value;
    } catch {
      /* 解析失败按「没有配置」处理，下面还有环境变量兜底 */
    }
  }
  const fromEnv = typeof process !== 'undefined' && process.env ? process.env[ref] : undefined;
  return fromEnv && fromEnv.length > 0 ? fromEnv : undefined;
}

/** 当前选中的服务商 + 模型（面板上给对应卡片打「当前在用」标记） */
function readActiveSelection(ctx) {
  const agentDefaultModel = optionalService(ctx, 'agentDefaultModel');
  if (!agentDefaultModel || typeof agentDefaultModel.currentSelection !== 'function') return null;
  try {
    const selection = agentDefaultModel.currentSelection();
    const provider = selection && typeof selection.provider === 'string' ? selection.provider : '';
    const model = selection && typeof selection.model === 'string' ? selection.model : '';
    return provider ? { provider, model } : null;
  } catch {
    return null;
  }
}

/** 服务商清单：优先已注册的实时路由，注册表为空时回落到适配器声明的可配置路由 */
function listProviders(llm) {
  const named = (id, displayName) => {
    const providerId = String(id ?? '');
    return providerId ? { id: providerId, name: String(displayName ?? '') || providerId } : undefined;
  };
  let providers = [];
  if (typeof llm.listProviders === 'function') {
    providers = llm.listProviders().map((entry) => named(entry?.id, entry?.name));
  }
  if (providers.length === 0 && typeof llm.listConfigurableProviders === 'function') {
    providers = llm.listConfigurableProviders().map((entry) => named(entry?.provider, entry?.displayName));
  }
  const seen = new Set();
  return providers.filter((entry) => {
    if (!entry || seen.has(entry.id)) return false;
    seen.add(entry.id);
    return true;
  });
}

/** 某服务商下的模型清单：列不出来只让卡片少几个 chip，不拖垮整张快照 */
async function listModels(llm, provider) {
  if (typeof llm.listModels !== 'function') return [];
  const timeout = new Promise((resolve) => setTimeout(() => resolve(undefined), MODEL_LIST_TIMEOUT_MS));
  try {
    const models = await Promise.race([llm.listModels(provider), timeout]);
    if (!Array.isArray(models)) return [];
    return models
      .map((entry) => {
        const id = String(entry?.id ?? '');
        return id ? { id, name: String(entry?.name ?? '') || id } : undefined;
      })
      .filter((entry) => entry !== undefined);
  } catch {
    return [];
  }
}

/** 一次余额查询：凭证 / 账号服务在前置检查，上游成功路径在 fetch 里 */
async function queryProvider(ctx, definition, providerId) {
  if (definition.credentialRef === null) {
    const account = optionalService(ctx, 'deepseekAccount');
    if (!account || typeof account.getBalance !== 'function') {
      const error = new Error('账号服务不在场（' + providerId + '）');
      error.code = 'CREDENTIAL_MISSING';
      throw error;
    }
    return definition.fetch({
      key: '',
      resolveAccount: () => account.getBalance(accountClientMetadata()),
    });
  }

  const key = await resolveCredential(ctx, definition.credentialRef);
  if (!key) {
    const error = new Error('没有配置凭证 ' + definition.credentialRef);
    error.code = 'CREDENTIAL_MISSING';
    throw error;
  }
  return definition.fetch({ key });
}

/** 单张服务商卡片：模型清单 + 余额状态 */
async function describeProvider(ctx, llm, provider, active) {
  const models = await listModels(llm, provider.id);
  const base = {
    id: provider.id,
    name: providerTitle(provider),
    models,
    activeModel: active && active.provider === provider.id ? active.model : null,
  };
  const definition = findProvider(provider.id);
  if (!definition) return { ...base, status: 'unsupported' };
  try {
    const result = await queryProvider(ctx, definition, provider.id);
    return { ...base, status: 'ok', shape: result.shape, windows: result.windows, money: result.money };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error && error.code === 'CREDENTIAL_MISSING') {
      return { ...base, status: 'credential-missing', message };
    }
    return { ...base, status: 'error', message };
  }
}

/** 完整快照：所有服务商并行查，单家失败只影响它自己 */
async function buildSnapshot(ctx) {
  const llm = ctx.llm;
  const active = readActiveSelection(ctx);
  const providers = listProviders(llm);
  const cards = await Promise.all(providers.map((provider) => describeProvider(ctx, llm, provider, active)));
  return {
    ok: true,
    fetchedAt: new Date().toISOString(),
    active,
    providers: cards,
  };
}

// ---------------------------------------------------------------------------
// 插件主体
// ---------------------------------------------------------------------------

/**
 * 宿主半侧入口。
 * @param ctx cordis 上下文（webServer / llm 已由 inject 保证）
 */
export function apply(ctx) {
  /** 最近一次快照（只做短时复用与并发合并，不落盘） */
  let cache = { at: 0, value: undefined };
  let inflight;

  /** 快照入口：force=1 跳过复用；同一时刻只跑一次上游 */
  const snapshot = (force) => {
    if (!force && cache.value !== undefined && Date.now() - cache.at < MIN_REFRESH_MS) {
      return Promise.resolve(cache.value);
    }
    if (inflight) return inflight;
    inflight = buildSnapshot(ctx)
      .then((value) => {
        cache = { at: Date.now(), value };
        return value;
      })
      .finally(() => {
        inflight = undefined;
      });
    return inflight;
  };

  /** 只认 GET /dsh-model-balance-panel/snapshot；其余路径与方法显式报错 */
  const handle = async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== SNAPSHOT_PATH) {
      res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, message: 'not found' }));
      return;
    }
    if (req.method !== 'GET') {
      res.writeHead(405, { 'content-type': 'application/json; charset=utf-8', allow: 'GET' });
      res.end(JSON.stringify({ ok: false, message: 'method not allowed' }));
      return;
    }
    const force = url.searchParams.get('force') === '1';
    try {
      const value = await snapshot(force);
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      });
      res.end(JSON.stringify(value));
    } catch (error) {
      res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
      res.end(
        JSON.stringify({
          ok: false,
          message: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  };

  ctx.effect(
    () => ctx.webServer.register({ kind: 'prefix', path: ROUTE_PREFIX, handler: handle }),
    'dsh-model-balance-panel: snapshot route',
  );
}
