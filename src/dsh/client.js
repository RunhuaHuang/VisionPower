/* global window */

window.__ModuleLoader__.load({
  id: 'visionpower/dsh',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    const React = require('react')

    const SETTINGS_ORIGIN = 'http://127.0.0.1:17900'
    const SETTINGS_URL = `${SETTINGS_ORIGIN}/?embed=dsh&parentOrigin=${encodeURIComponent(window.location.origin)}`
    const inject = ['slots']

    function VisionPowerSettingsTab() {
      const iframeRef = React.useRef(null)
      const [connection, setConnection] = React.useState({ state: 'connecting', detail: '' })

      React.useEffect(() => {
        const onMessage = (event) => {
          if (event.origin !== SETTINGS_ORIGIN || event.source !== iframeRef.current?.contentWindow) return
          const message = event.data
          if (message?.type !== 'visionpower:webui-ready') return
          if (message.product !== 'visionpower' || message.protocolVersion !== 1) {
            setConnection({ state: 'error', detail: '17900 端口上的服务不是兼容的 VisionPower 配置控制台。' })
            return
          }
          setConnection({ state: 'ready', detail: `VisionPower ${message.version || ''}`.trim() })
        }
        window.addEventListener('message', onMessage)
        const timeout = window.setTimeout(() => {
          setConnection((current) => current.state === 'connecting'
            ? { state: 'error', detail: '无法验证 17900 端口上的 VisionPower 配置控制台，请检查端口冲突或重启 dsh。' }
            : current)
        }, 5000)
        return () => {
          window.clearTimeout(timeout)
          window.removeEventListener('message', onMessage)
        }
      }, [])

      return React.createElement('div', {
        style: {
          width: '100%',
          maxWidth: '980px',
          display: 'flex',
          flexDirection: 'column',
          gap: '12px',
        },
      },
      React.createElement('div', {
        style: {
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '12px',
          color: 'var(--dsw-alias-label-secondary)',
          fontSize: '13px',
        },
      },
      React.createElement('span', null, '视觉模型与 API Key 在测试后需点击“保存并应用配置”；VisionPower 开关切换后立即生效。'),
      React.createElement('a', {
        href: SETTINGS_ORIGIN,
        target: '_blank',
        rel: 'noopener noreferrer',
        style: { color: 'var(--dsw-alias-state-business-primary)', whiteSpace: 'nowrap' },
      }, '在独立窗口打开')),
      connection.state !== 'ready' && React.createElement('div', {
        role: connection.state === 'error' ? 'alert' : 'status',
        style: {
          padding: '16px',
          border: `1px solid ${connection.state === 'error' ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-border-l2)'}`,
          borderRadius: '10px',
          color: connection.state === 'error' ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-label-secondary)',
          background: 'var(--dsw-alias-bg-layer-1)',
        },
      }, connection.state === 'error' ? connection.detail : '正在连接 VisionPower 配置控制台…'),
      React.createElement('iframe', {
        ref: iframeRef,
        src: SETTINGS_URL,
        title: 'VisionPower Settings',
        sandbox: 'allow-scripts allow-forms allow-same-origin allow-popups',
        referrerPolicy: 'no-referrer',
        style: {
          width: '100%',
          display: connection.state === 'ready' ? 'block' : 'none',
          height: 'min(78vh, 920px)',
          minHeight: '620px',
          border: '1px solid var(--dsw-alias-border-l2)',
          borderRadius: '10px',
          background: 'var(--dsw-alias-bg-layer-1)',
        },
      }))
    }

    function apply(ctx) {
      ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
        name: 'settings.plugins.tab',
        id: 'visionpower',
        order: 50,
        label: () => 'VisionPower',
      }, VisionPowerSettingsTab))
    }

    exports.inject = inject
    exports.apply = apply
    return module.exports
  },
})
