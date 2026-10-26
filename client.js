/**
 * dsh-model-balance-panel —— 浏览器半侧（Client）。
 *
 * 两处注册：
 *   1. `sidebar.panellist`：左侧栏的全局面板图标（id 即主面板的 key）。
 *   2. `main`：点图标后真正渲染的余额面板。
 *
 * 数据全部来自宿主半侧的 `GET /dsh-model-balance-panel/snapshot`（同源相对路径），
 * 页面自己不碰凭证、不直连任何服务商接口。进入面板（组件挂载）即刷新一次，
 * 之后由「刷新」按钮显式刷新。
 */
window.__ModuleLoader__.load({
  id: 'dsh-model-balance-panel',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useCallback, useEffect, useState } = React;

    /** 本地化命名空间（与宿主插件名一致） */
    const NS = 'model-balance-panel';
    /** 宿主半侧的快照端点 */
    const SNAPSHOT_ENDPOINT = '/dsh-model-balance-panel/snapshot';

    // ------------------------------------------------------------------
    // 文案：两套字典在 apply 里注册进 ctx.locale，语言切换后 label thunk 重新取值
    // ------------------------------------------------------------------
    const ZH = {
      'nav.label': '模型余额',
      'title': '模型余额',
      'subtitle': '各服务商账户的余额与额度；打开本页即刷新。',
      'refresh': '刷新',
      'refreshing': '刷新中…',
      'updatedAt': '更新于',
      'loading': '正在读取余额…',
      'retry': '重试',
      'summary.providers': '个服务商',
      'summary.models': '个模型',
      'summary.dot': ' · ',
      'current': '当前在用',
      'status.ok': '已同步',
      'status.unsupported': '不支持查询',
      'status.credential-missing': '未配置凭证',
      'status.error': '查询失败',
      'window.rolling': '5 小时额度',
      'window.weekly': '周额度',
      'window.monthly': '月额度',
      'window.used': '已用',
      'window.remaining': '剩余',
      'window.reset': '重置',
      'window.resetDone': '已重置',
      'money.total': '可用余额',
      'money.granted': '赠送',
      'money.toppedUp': '充值',
      'models': '模型',
      'noModels': '未列出模型',
      'empty.title': '还没有可查询余额的服务商',
      'empty.hint': '在「设置 → 模型」里配置服务商与 API Key 之后，这里会显示它们的余额。',
      'footnote': '余额只取自服务商接口；取不到时显示原因，不会显示 0。',
      'error.prefix': '读取失败：',
    };

    const EN = {
      'nav.label': 'Model balance',
      'title': 'Model balance',
      'subtitle': 'Balances and quotas from each provider account; opening this page refreshes.',
      'refresh': 'Refresh',
      'refreshing': 'Refreshing…',
      'updatedAt': 'Updated',
      'loading': 'Reading balances…',
      'retry': 'Retry',
      'summary.providers': ' providers',
      'summary.models': ' models',
      'summary.dot': ' · ',
      'current': 'Active',
      'status.ok': 'Synced',
      'status.unsupported': 'Not supported',
      'status.credential-missing': 'No credential',
      'status.error': 'Failed',
      'window.rolling': '5-hour quota',
      'window.weekly': 'Weekly quota',
      'window.monthly': 'Monthly quota',
      'window.used': 'Used',
      'window.remaining': 'Left',
      'window.reset': 'Reset',
      'window.resetDone': 'Reset',
      'money.total': 'Balance',
      'money.granted': 'Granted',
      'money.toppedUp': 'Topped up',
      'models': 'Models',
      'noModels': 'No models listed',
      'empty.title': 'No provider to query yet',
      'empty.hint': 'Configure a provider and its API key in Settings → Models, then balances appear here.',
      'footnote': 'Numbers come from provider APIs only; failures show a reason, never a fake zero.',
      'error.prefix': 'Request failed: ',
    };

    // ------------------------------------------------------------------
    // 样式：只用宿主主题令牌（--dsw-alias-*），浅色/深色自动跟随
    // ------------------------------------------------------------------
    const CSS = [
      '.mb-root{height:100%;min-height:0;overflow:auto;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.55}',
      '.mb-inner{max-width:860px;margin:0 auto;padding:22px 24px 44px}',
      '.mb-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px}',
      '.mb-headtext{min-width:0}',
      '.mb-title{margin:0;font-size:19px;font-weight:600;letter-spacing:.01em;display:flex;align-items:center;gap:8px}',
      '.mb-title svg{flex:none;opacity:.9}',
      '.mb-subtitle{margin:4px 0 0;font-size:12px;color:var(--dsw-alias-label-secondary)}',
      '.mb-actions{display:flex;align-items:center;gap:8px;flex:none}',
      '.mb-meta{margin-top:10px;font-size:11px;color:var(--dsw-alias-label-secondary);display:flex;align-items:center;gap:8px;min-height:16px}',
      '.mb-btn{display:inline-flex;align-items:center;gap:6px;height:30px;padding:0 12px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;cursor:pointer;white-space:nowrap}',
      '.mb-btn:hover:not(:disabled){border-color:var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2)}',
      '.mb-btn:disabled{opacity:.55;cursor:default}',
      '.mb-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}',
      '.mb-cards{display:flex;flex-direction:column;gap:12px;margin-top:16px}',
      '.mb-card{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);padding:14px 16px 12px}',
      '.mb-cardhead{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
      '.mb-provider{font-size:14px;font-weight:600;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.mb-id{font-size:11px;color:var(--dsw-alias-label-secondary);font-family:ui-monospace,SFMono-Regular,Consolas,monospace}',
      '.mb-spacer{flex:1 1 auto}',
      '.mb-badge{flex:none;display:inline-flex;align-items:center;gap:4px;height:20px;padding:0 7px;border-radius:999px;font-size:11px;border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-brand-primary);background:transparent}',
      '.mb-badge::before{content:"";width:5px;height:5px;border-radius:50%;background:currentColor}',
      '.mb-status{flex:none;font-size:11px;color:var(--dsw-alias-label-secondary);display:inline-flex;align-items:center;gap:5px}',
      '.mb-status::before{content:"";width:6px;height:6px;border-radius:50%;background:currentColor;opacity:.85}',
      '.mb-status-ok{color:var(--dsw-alias-state-success-primary)}',
      '.mb-status-credential-missing{color:var(--dsw-alias-state-warn-primary)}',
      '.mb-status-error{color:var(--dsw-alias-state-error-primary)}',
      '.mb-status-unsupported{color:var(--dsw-alias-state-idle-primary)}',
      '.mb-windows{display:flex;flex-direction:column;gap:10px;margin-top:12px}',
      '.mb-window{display:flex;flex-direction:column;gap:5px}',
      '.mb-windowtop{display:flex;align-items:baseline;justify-content:space-between;gap:12px;font-size:12px}',
      '.mb-windowlabel{color:var(--dsw-alias-label-secondary)}',
      '.mb-windowused{font-variant-numeric:tabular-nums;font-weight:600}',
      '.mb-bar{position:relative;height:6px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);overflow:hidden}',
      '.mb-bar>i{position:absolute;inset:0 auto 0 0;display:block;border-radius:999px;background:var(--dsw-alias-brand-primary);transition:width .18s ease}',
      '.mb-bar-warn>i{background:var(--dsw-alias-state-warn-primary)}',
      '.mb-bar-error>i{background:var(--dsw-alias-state-error-primary)}',
      '.mb-windowfoot{display:flex;align-items:baseline;justify-content:space-between;gap:12px;font-size:11px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}',
      '.mb-money{margin-top:12px;display:flex;align-items:baseline;gap:14px;flex-wrap:wrap}',
      '.mb-moneytotal{font-size:22px;font-weight:600;font-variant-numeric:tabular-nums;letter-spacing:.01em}',
      '.mb-moneyparts{display:flex;gap:12px;flex-wrap:wrap;font-size:11px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}',
      '.mb-note{margin:10px 0 0;font-size:12px;color:var(--dsw-alias-label-secondary);word-break:break-word}',
      '.mb-note-error{color:var(--dsw-alias-state-error-primary)}',
      '.mb-models{margin-top:12px;padding-top:10px;border-top:1px solid var(--dsw-alias-border-l1);display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:11px;color:var(--dsw-alias-label-secondary)}',
      '.mb-modelslabel{flex:none}',
      '.mb-chip{display:inline-flex;align-items:center;height:20px;padding:0 8px;border-radius:6px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-size:11px;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.mb-chip-current{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}',
      '.mb-empty{margin-top:20px;border:1px dashed var(--dsw-alias-border-l2);border-radius:10px;padding:22px;text-align:center}',
      '.mb-emptytitle{font-size:13px;font-weight:600}',
      '.mb-emptyhint{margin-top:6px;font-size:12px;color:var(--dsw-alias-label-secondary)}',
      '.mb-loading{margin-top:22px;font-size:12px;color:var(--dsw-alias-label-secondary)}',
      '.mb-footnote{margin-top:18px;font-size:11px;color:var(--dsw-alias-label-secondary)}',
      '@media (prefers-reduced-motion: reduce){.mb-bar>i{transition:none}}',
    ].join('\n');

    // ------------------------------------------------------------------
    // 展示工具
    // ------------------------------------------------------------------

    /** 金额符号：接口给的是 ISO 币种码，认不出就带码显示 */
    function currencyPrefix(currency) {
      switch (currency) {
        case 'CNY':
        case 'RMB':
          return '¥';
        case 'USD':
          return '$';
        case 'EUR':
          return '€';
        default:
          return currency ? currency + ' ' : '';
      }
    }

    /** 比例文本：整数就整数，带小数保留一位 */
    function percentText(percent) {
      const value = Math.max(0, Number(percent) || 0);
      const rounded = Math.round(value * 10) / 10;
      return (Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1)) + '%';
    }

    /** 进度条长度：超过 100% 也按满格画，数字本身如实显示 */
    function barWidth(percent) {
      const value = Math.max(0, Math.min(100, Number(percent) || 0));
      return value + '%';
    }

    /** 进度条配色档位 */
    function barTone(percent) {
      const value = Number(percent) || 0;
      if (value >= 90) return ' mb-bar-error';
      if (value >= 70) return ' mb-bar-warn';
      return '';
    }

    /** 金额：接口给的是字符串，保留两位 */
    function moneyText(value) {
      const n = Number(value);
      return Number.isFinite(n) ? n.toFixed(2) : String(value);
    }

    /** 剩余额度 = 满额度 × (1 - 已用比例) */
    function remainingText(window) {
      const cap = Number(window && window.capUsd);
      const percent = Number(window && window.percent);
      if (!Number.isFinite(cap) || !Number.isFinite(percent)) return undefined;
      return '$' + (cap * Math.max(0, 1 - percent / 100)).toFixed(2);
    }

    /** 重置时间：固定 MM-DD HH:mm（语言无关），已过去则显示「已重置」 */
    function resetText(iso, t) {
      if (!iso) return undefined;
      const date = new Date(iso);
      if (Number.isNaN(date.getTime())) return undefined;
      if (date.getTime() <= Date.now()) return t('window.resetDone');
      const pad = (n) => (n < 10 ? '0' + n : String(n));
      const stamp =
        pad(date.getMonth() + 1) + '-' + pad(date.getDate()) + ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes());
      return t('window.reset') + ' ' + stamp;
    }

    /** 快照时间：HH:mm */
    function clockText(iso) {
      const date = iso ? new Date(iso) : new Date();
      if (Number.isNaN(date.getTime())) return '';
      const pad = (n) => (n < 10 ? '0' + n : String(n));
      return pad(date.getHours()) + ':' + pad(date.getMinutes()) + ':' + pad(date.getSeconds());
    }

    /** 中文服务商名的兜底：id 原样显示 */
    function providerTitle(provider) {
      return provider && provider.name ? provider.name : provider && provider.id ? provider.id : '';
    }

    // ------------------------------------------------------------------
    // 视图
    // ------------------------------------------------------------------

    /** 单窗口一行：标签 + 进度 + 已用 / 剩余 / 重置 */
    function WindowRow(props) {
      const { t, label, window } = props;
      const percent = Number(window && window.percent) || 0;
      const remaining = remainingText(window);
      const reset = resetText(window && window.resetsAt, t);
      const foot = [];
      if (remaining) foot.push(t('window.remaining') + ' ' + remaining);
      if (reset) foot.push(reset);
      return h(
        'div',
        { className: 'mb-window' },
        h(
          'div',
          { className: 'mb-windowtop' },
          h('span', { className: 'mb-windowlabel' }, label),
          h('span', { className: 'mb-windowused' }, t('window.used') + ' ' + percentText(percent)),
        ),
        h(
          'div',
          { className: 'mb-bar' + barTone(percent), role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': Math.round(Math.max(0, Math.min(100, percent))), 'aria-label': label },
          h('i', { style: { width: barWidth(percent) } }),
        ),
        foot.length > 0 ? h('div', { className: 'mb-windowfoot' }, h('span', null, foot[0]), h('span', null, foot[1] || '')) : null,
      );
    }

    /** 三窗口区块（缺哪个窗口就不画哪一行） */
    function Windows(props) {
      const { t, windows } = props;
      const rows = [];
      if (windows && windows.rolling) rows.push(h(WindowRow, { key: 'rolling', t, label: t('window.rolling'), window: windows.rolling }));
      if (windows && windows.weekly) rows.push(h(WindowRow, { key: 'weekly', t, label: t('window.weekly'), window: windows.weekly }));
      if (windows && windows.monthly) rows.push(h(WindowRow, { key: 'monthly', t, label: t('window.monthly'), window: windows.monthly }));
      return rows.length > 0 ? h('div', { className: 'mb-windows' }, rows) : null;
    }

    /** 账户金额区块 */
    function Money(props) {
      const { t, money } = props;
      if (!money) return null;
      const symbol = currencyPrefix(money.currency);
      return h(
        'div',
        { className: 'mb-money' },
        h('span', { className: 'mb-moneytotal' }, symbol + moneyText(money.total)),
        h(
          'span',
          { className: 'mb-moneyparts' },
          h('span', null, t('money.granted') + ' ' + symbol + moneyText(money.granted)),
          h('span', null, t('money.toppedUp') + ' ' + symbol + moneyText(money.toppedUp)),
        ),
      );
    }

    /** 一张服务商卡片 */
    function ProviderCard(props) {
      const { t, provider } = props;
      const status = provider.status;
      const current = provider.activeModel !== null && provider.activeModel !== undefined;
      const models = Array.isArray(provider.models) ? provider.models : [];
      const modelLabel = (model) => model.name || model.id;

      return h(
        'section',
        { className: 'mb-card' },
        h(
          'div',
          { className: 'mb-cardhead' },
          h('span', { className: 'mb-provider', title: providerTitle(provider) }, providerTitle(provider)),
          provider.id && provider.id !== provider.name ? h('span', { className: 'mb-id' }, provider.id) : null,
          current ? h('span', { className: 'mb-badge' }, t('current')) : null,
          h('span', { className: 'mb-spacer' }),
          h('span', { className: 'mb-status mb-status-' + status }, t('status.' + status)),
        ),
        status === 'ok' && provider.shape === 'windows' ? h(Windows, { t, windows: provider.windows }) : null,
        status === 'ok' && provider.shape === 'money' ? h(Money, { t, money: provider.money }) : null,
        status !== 'ok'
          ? h('p', { className: 'mb-note' + (status === 'error' ? ' mb-note-error' : '') }, provider.message || t('status.' + status))
          : null,
        h(
          'div',
          { className: 'mb-models' },
          h('span', { className: 'mb-modelslabel' }, t('models')),
          models.length === 0
            ? h('span', null, t('noModels'))
            : models.map((model) =>
                h(
                  'span',
                  {
                    key: model.id,
                    className: 'mb-chip' + (provider.activeModel === model.id ? ' mb-chip-current' : ''),
                    title: model.id,
                  },
                  modelLabel(model),
                ),
              ),
        ),
      );
    }

    /** 主面板 */
    function makePanel(t) {
      return function BalancePanel() {
        const [data, setData] = useState(null);
        const [error, setError] = useState(null);
        const [loading, setLoading] = useState(true);

        const load = useCallback(
          async (force) => {
            setLoading(true);
            setError(null);
            try {
              const response = await fetch(SNAPSHOT_ENDPOINT + (force ? '?force=1' : ''), {
                headers: { accept: 'application/json' },
                cache: 'no-store',
              });
              if (!response.ok) throw new Error('HTTP ' + response.status);
              const body = await response.json();
              if (!body || body.ok !== true) throw new Error(body && body.message ? body.message : 'invalid snapshot');
              setData(body);
            } catch (failure) {
              setError(failure instanceof Error ? failure.message : String(failure));
            } finally {
              setLoading(false);
            }
          },
          // t 只影响文案，不参与取数
          [],
        );

        // 进入面板即刷新：组件挂载 = 用户切到这一页
        useEffect(() => {
          void load(false);
        }, [load]);

        const providers = data && Array.isArray(data.providers) ? data.providers : [];
        const modelCount = providers.reduce((sum, provider) => sum + (Array.isArray(provider.models) ? provider.models.length : 0), 0);

        return h(
          'div',
          { className: 'mb-root' },
          h('style', null, CSS),
          h(
            'div',
            { className: 'mb-inner' },
            h(
              'header',
              { className: 'mb-head' },
              h(
                'div',
                { className: 'mb-headtext' },
                h('h1', { className: 'mb-title' }, h(WalletGlyph, { size: 18 }), t('title')),
                h('p', { className: 'mb-subtitle' }, t('subtitle')),
              ),
              h(
                'div',
                { className: 'mb-actions' },
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'mb-btn',
                    onClick: () => void load(true),
                    disabled: loading,
                    'aria-busy': loading ? 'true' : 'false',
                  },
                  h(RefreshGlyph, { size: 13 }),
                  loading ? t('refreshing') : t('refresh'),
                ),
              ),
            ),
            h(
              'div',
              { className: 'mb-meta' },
              data && data.fetchedAt ? h('span', null, t('updatedAt') + ' ' + clockText(data.fetchedAt)) : null,
              data
                ? h(
                    'span',
                    null,
                    providers.length + t('summary.providers') + t('summary.dot') + modelCount + t('summary.models'),
                  )
                : null,
            ),
            error
              ? h(
                  'div',
                  { className: 'mb-empty', role: 'alert' },
                  h('div', { className: 'mb-emptytitle' }, t('error.prefix') + error),
                  h(
                    'button',
                    { type: 'button', className: 'mb-btn', style: { marginTop: '12px' }, onClick: () => void load(true) },
                    t('retry'),
                  ),
                )
              : null,
            !error && loading && !data ? h('div', { className: 'mb-loading', role: 'status' }, t('loading')) : null,
            !error && data && providers.length === 0
              ? h(
                  'div',
                  { className: 'mb-empty' },
                  h('div', { className: 'mb-emptytitle' }, t('empty.title')),
                  h('div', { className: 'mb-emptyhint' }, t('empty.hint')),
                )
              : null,
            providers.length > 0
              ? h('div', { className: 'mb-cards' }, providers.map((provider) => h(ProviderCard, { key: provider.id, t, provider })))
              : null,
            h('p', { className: 'mb-footnote' }, t('footnote')),
          ),
        );
      };
    }

    /** 左栏图标：钱包 + 硬币点，用 currentColor 跟随选中态 */
    function WalletGlyph(props) {
      const size = Number(props && props.size) || 16;
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 20 20',
          fill: 'none',
          'aria-hidden': 'true',
          focusable: 'false',
          style: { display: 'block', flex: 'none' },
        },
        h('rect', {
          x: 2.7,
          y: 5.4,
          width: 14.6,
          height: 10.3,
          rx: 2.6,
          stroke: 'currentColor',
          strokeWidth: 1.5,
        }),
        h('path', { d: 'M2.7 8.5h14.6', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round' }),
        h('circle', { cx: 13.6, cy: 12.1, r: 1.3, fill: 'currentColor' }),
      );
    }

    /** 刷新图标 */
    function RefreshGlyph(props) {
      const size = Number(props && props.size) || 13;
      return h(
        'svg',
        { width: size, height: size, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true', focusable: 'false' },
        h('path', {
          d: 'M13.2 8a5.2 5.2 0 1 1-1.6-3.7',
          stroke: 'currentColor',
          strokeWidth: 1.5,
          strokeLinecap: 'round',
        }),
        h('path', { d: 'M13.4 2.4v3.1h-3.1', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round' }),
      );
    }

    return {
      name: NS,
      inject: ['slots', 'locale'],
      apply(ctx) {
        // 文案字典：语言切换时 ctx.locale 重新投影 label thunk
        ctx.effect(() => ctx.locale.register(NS, { zh: ZH, en: EN }), 'dsh-model-balance-panel: dictionaries');
        // 取词兜底：宿主没有该命名空间/语言时，退回本插件的词典，绝不把裸 key 显示给用户
        const translate = ctx.locale.bind(NS);
        const t = (key) => {
          const value = typeof translate === 'function' ? translate(key) : undefined;
          return typeof value === 'string' && value.length > 0 && value !== key ? value : ZH[key] || key;
        };

        // 左栏入口：id 必须与 main 的 key 一致，否则点了不会切到本面板
        ctx.slots.inject('sidebar.panellist', function* () {
          yield ctx.slots.register(
            {
              name: 'sidebar.panellist',
              id: 'model-balance-panel',
              order: 20,
              label: () => t('nav.label'),
            },
            function SidebarBalanceIcon(props) {
              return h(WalletGlyph, { size: props && props.size });
            },
          );
        });

        // 主面板：与左栏条目同 key
        ctx.slots.inject('main', function* () {
          yield ctx.slots.register({ name: 'main', key: 'model-balance-panel' }, makePanel(t));
        });
      },
    };
  },
});
