export const WEBUI_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>VisionPower · Image Understanding Console</title>
<script defer src="/assets/alpine.min.js"></script>
<script>
(function(){
  try {
    var theme = localStorage.getItem('vp-theme') || 'dark';
    document.documentElement.setAttribute('data-theme', theme);
  } catch(e) { document.documentElement.setAttribute('data-theme','dark'); }
})();
</script>
<style>
[data-theme="dark"]{
  --surface-0:#0c0d0a;
  --surface-2:#1a1c16;
  --surface-3:#232520;
  --surface-4:#2d3028;
  --text-primary:#ecebe1;
  --text-secondary:#b8b8a8;
  --text-muted:#7a7b6c;
  --text-dim:#494a41;
  --signal:#c4f542;
  --signal-dim:#7a9426;
  --signal-glow:rgba(196,245,66,.35);
  --signal-contrast:#0c0d0a;
  --warn:#f5a142;
  --error:#f55d5d;
  --info:#5fb8f5;
  --line:#2f3128;
  --line-bright:#42453a;
  --code-bg:#0a0b08;
  --code-text:#c8c8b8;
  --grid-opacity:.25;
  --noise-opacity:.04;
  --shadow-lg:0 20px 50px -20px rgba(0,0,0,.8), 0 1px 0 var(--line-bright) inset;
}
[data-theme="light"]{
  --surface-0:#f3f1ea;
  --surface-2:#ffffff;
  --surface-3:#faf8f1;
  --surface-4:#efede4;
  --text-primary:#1c1d18;
  --text-secondary:#54544a;
  --text-muted:#86867a;
  --text-dim:#b0b0a4;
  --signal:#5d7a14;
  --signal-dim:#8aa82e;
  --signal-glow:rgba(93,122,20,.18);
  --signal-contrast:#ffffff;
  --warn:#b5610a;
  --error:#c63838;
  --info:#2a7ab8;
  --line:#e2dfd2;
  --line-bright:#cfccbe;
  --code-bg:#fbfaf3;
  --code-text:#3a3a30;
  --grid-opacity:.5;
  --noise-opacity:.025;
  --shadow-lg:0 20px 50px -22px rgba(60,55,40,.22), 0 1px 0 var(--line-bright) inset;
}
:root{
  --space-xs:.375rem; --space-sm:.625rem; --space-md:1rem;
  --space-lg:1.75rem; --space-xl:3rem;
  --fs-mono-xs:.6875rem; --fs-mono-sm:.75rem; --fs-mono-md:.8125rem;
  --fs-display-lg:clamp(1.5rem,3vw,2.125rem);
  --fs-body:.9375rem;
  --radius:2px;
  --font-sans:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,sans-serif;
  --font-mono:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;
}
*{box-sizing:border-box;margin:0;padding:0}
html,body{
  background:var(--surface-0);
  color:var(--text-primary);
  font-family:var(--font-sans);
  font-size:var(--fs-body);
  line-height:1.5;
  -webkit-font-smoothing:antialiased;
  min-height:100vh;
}
body::before{
  content:"";position:fixed;inset:0;z-index:-2;pointer-events:none;
  background-image:
    linear-gradient(var(--line) 1px,transparent 1px),
    linear-gradient(90deg,var(--line) 1px,transparent 1px);
  background-size:64px 64px;
  opacity:var(--grid-opacity);
  mask-image:radial-gradient(ellipse at top,#000 0%,transparent 75%);
}
.mono{font-family:var(--font-mono);font-feature-settings:"ss01","ss02"}
.wrap{max-width:1000px;margin:0 auto;padding:var(--space-xl) var(--space-md) var(--space-xl)}
.label{font-family:var(--font-mono);font-size:var(--fs-mono-xs);font-weight:500;
  letter-spacing:.12em;text-transform:uppercase;color:var(--text-muted)}
input,select,textarea{
  width:100%;background:var(--surface-4);border:1px solid var(--line);
  color:var(--text-primary);padding:var(--space-sm) var(--space-md);
  border-radius:var(--radius);font-family:var(--font-mono);font-size:var(--fs-mono-md);
  transition:border-color .15s,box-shadow .15s;
}
input:focus,select:focus,textarea:focus{outline:none;border-color:var(--signal);
  box-shadow:0 0 0 3px var(--signal-glow)}
select{appearance:none;background-image:url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'><path fill='%23a8a89a' d='M2 4l4 4 4-4'/></svg>");
  background-repeat:no-repeat;background-position:right var(--space-md) center;padding-right:2.25rem}
[data-theme="light"] select{background-image:url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'><path fill='%2386867a' d='M2 4l4 4 4-4'/></svg>")}

header{display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid var(--line);padding-bottom:var(--space-md);margin-bottom:var(--space-lg)}
.logo{display:flex;align-items:center;gap:var(--space-sm)}
.logo-icon{width:20px;height:20px;background:var(--signal);border-radius:var(--radius);box-shadow:0 0 8px var(--signal)}
.logo-title{font-size:var(--fs-display-lg);font-weight:700;letter-spacing:-0.03em;font-family:var(--font-mono)}
.logo-subtitle{font-size:var(--fs-mono-xs);color:var(--text-muted);font-family:var(--font-mono);letter-spacing:0.1em;text-transform:uppercase}
.version-badge{display:inline-block;font-family:var(--font-mono);font-size:var(--fs-mono-xs);font-weight:700;letter-spacing:.05em;color:var(--signal);background:rgba(196,245,66,.1);border:1px solid var(--signal-dim);padding:2px 8px;border-radius:var(--radius);white-space:nowrap}

.tabs{display:flex;gap:var(--space-xs);background:var(--surface-3);padding:2px;border-radius:var(--radius);border:1px solid var(--line)}
.tab-btn{background:transparent;border:0;color:var(--text-secondary);font-family:var(--font-mono);font-size:var(--fs-mono-md);padding:var(--space-sm) var(--space-md);border-radius:var(--radius);cursor:pointer;transition:all .15s}
.tab-btn.active{background:var(--surface-4);color:var(--signal)}
.tab-btn:hover:not(.active){color:var(--text-primary)}

.theme-toggle{background:transparent;border:1px solid var(--line);color:var(--text-secondary);font-family:var(--font-mono);font-size:var(--fs-mono-xs);padding:var(--space-sm) var(--space-md);border-radius:var(--radius);cursor:pointer}
.theme-toggle:hover{border-color:var(--line-bright);color:var(--text-primary)}

.card{background:var(--surface-2);border:1px solid var(--line);border-radius:var(--radius);padding:var(--space-lg);margin-bottom:var(--space-lg);position:relative;box-shadow:0 4px 20px -10px rgba(0,0,0,.4)}
.card-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:var(--space-md);border-bottom:1px solid var(--line);padding-bottom:var(--space-sm)}
.card-title{font-size:var(--fs-mono-md);font-weight:700;color:var(--text-primary);letter-spacing:0.05em}

.grid-2{display:grid;grid-template-columns:1fr 1fr;gap:var(--space-md)}
.grid-3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:var(--space-md)}
.form-group{margin-bottom:var(--space-md)}
.form-group label{display:block;margin-bottom:var(--space-xs)}
.form-inline{display:flex;align-items:center;gap:var(--space-sm)}

.btn{background:var(--signal);color:var(--signal-contrast);border:0;font-family:var(--font-mono);font-size:var(--fs-mono-md);font-weight:700;padding:var(--space-sm) var(--space-lg);border-radius:var(--radius);cursor:pointer;transition:all .15s;display:inline-flex;align-items:center;justify-content:center;gap:var(--space-sm)}
.btn:hover{opacity:.9;box-shadow:0 0 12px var(--signal-glow)}
.btn-secondary{background:var(--surface-4);color:var(--text-primary);border:1px solid var(--line)}
.btn-secondary:hover{background:var(--line-bright);box-shadow:none}
.btn:disabled{opacity:0.5;cursor:not-allowed}

.alert{padding:var(--space-md);border-radius:var(--radius);margin-bottom:var(--space-lg);font-size:var(--fs-mono-md);display:flex;align-items:center;gap:var(--space-sm)}
.alert-success{background:rgba(196,245,66,0.1);border:1px solid var(--signal);color:var(--text-primary)}
.alert-error{background:rgba(245,93,93,0.1);border:1px solid var(--error);color:var(--error)}

.badge{display:inline-block;padding:2px 6px;border-radius:var(--radius);font-size:var(--fs-mono-xs);font-weight:700}
.badge-ready{background:rgba(196,245,66,0.15);color:var(--signal);border:1px solid var(--signal)}
.badge-not-ready{background:rgba(245,161,66,0.15);color:var(--warn);border:1px solid var(--warn)}

.playground-split{display:grid;grid-template-columns:1fr 1.2fr;gap:var(--space-lg)}
.dropzone{border:2px dashed var(--line);border-radius:var(--radius);padding:var(--space-xl) var(--space-md);text-align:center;cursor:pointer;transition:border-color .15s;position:relative}
.dropzone:hover{border-color:var(--signal)}
.dropzone-img{max-width:100%;max-height:220px;object-fit:contain;border-radius:var(--radius);margin-top:var(--space-md)}
.result-box{background:var(--code-bg);color:var(--code-text);font-family:var(--font-mono);font-size:var(--fs-mono-md);padding:var(--space-md);border-radius:var(--radius);border:1px solid var(--line);min-height:300px;white-space:pre-wrap;overflow-y:auto}

code-block{display:block;background:var(--code-bg);color:var(--code-text);font-family:var(--font-mono);font-size:var(--fs-mono-sm);padding:var(--space-md);border-radius:var(--radius);border:1px solid var(--line);position:relative;margin-top:var(--space-sm);overflow-x:auto}
.copy-btn{position:absolute;right:var(--space-sm);top:var(--space-sm);background:var(--surface-3);color:var(--text-secondary);border:1px solid var(--line);padding:2px 8px;border-radius:var(--radius);font-size:var(--fs-mono-xs);cursor:pointer}
.copy-btn:hover{color:var(--text-primary);border-color:var(--line-bright)}

.toggle-group{display:flex;align-items:center;justify-content:space-between;padding:var(--space-sm) 0;border-bottom:1px solid var(--line)}

@media (max-width: 768px) {
  .grid-2, .playground-split { grid-template-columns: 1fr; }
}
</style>
</head>
<body x-data="consoleApp()">
<div class="wrap">
  <header>
    <div class="logo">
      <div class="logo-icon"></div>
      <div>
        <div style="display:flex;align-items:center;gap:var(--space-sm)">
          <h1 class="logo-title">VISIONPOWER</h1>
          <span class="version-badge">v__VISIONPOWER_VERSION__</span>
        </div>
        <div class="logo-subtitle" x-text="i18n[lang].subtitle"></div>
      </div>
    </div>
    <div style="display:flex;gap:var(--space-sm);align-items:center">
      <div class="tabs">
        <button class="tab-btn" :class="activeTab === 'config' && 'active'" @click="activeTab = 'config'" x-text="lang === 'zh' ? '配置 CONFIG' : 'CONFIG'"></button>
        <button class="tab-btn" :class="activeTab === 'playground' && 'active'" @click="activeTab = 'playground'" x-text="lang === 'zh' ? '测试 PLAYGROUND' : 'PLAYGROUND'"></button>
        <button class="tab-btn" :class="activeTab === 'guide' && 'active'" @click="activeTab = 'guide'" x-text="lang === 'zh' ? '集成 PATCH BAY' : 'PATCH BAY'"></button>
      </div>
      <button class="theme-toggle" @click="toggleLang()" x-text="lang === 'zh' ? 'ENGLISH' : '中文'"></button>
      <button class="theme-toggle" @click="toggleTheme()" x-text="theme === 'dark' ? 'LIGHT' : 'DARK'"></button>
    </div>
  </header>

  <div x-show="alert.msg" class="alert" :class="alert.type === 'success' ? 'alert-success' : 'alert-error'">
    <span x-text="alert.type === 'success' ? '✓' : '⚠'"></span>
    <span x-text="alert.msg"></span>
  </div>

  <!-- CONFIG TAB -->
  <div x-show="activeTab === 'config'">
    <div class="card">
      <div class="card-header">
        <h2 class="card-title" x-text="i18n[lang].credentialsTitle"></h2>
        <div style="display:flex;align-items:center;gap:var(--space-sm)">
          <span class="label" x-text="i18n[lang].statusLabel"></span>
          <span class="badge" :class="status.ready ? 'badge-ready' : 'badge-not-ready'" x-text="status.ready ? i18n[lang].statusLive : i18n[lang].statusUnconfigured"></span>
        </div>
      </div>

      <div class="grid-2">
        <div class="form-group">
          <label class="label" x-text="i18n[lang].presetLabel"></label>
          <select x-model="config.presetId" @change="onPresetChange()">
            <template x-for="p in presets" :key="p.model">
              <option :value="p.model" x-text="p.label"></option>
            </template>
            <option value="custom" x-text="i18n[lang].presetCustom"></option>
          </select>
        </div>

        <div class="form-group" x-show="config.presetId === 'custom'">
          <label class="label" x-text="i18n[lang].customModelLabel"></label>
          <input type="text" x-model="config.model" placeholder="e.g. gpt-4o" />
        </div>
      </div>

      <div class="form-group">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:var(--space-xs)">
          <label class="label" style="margin-bottom:0" x-text="i18n[lang].apiKeyLabel"></label>
          <a :href="apiKeyLink" target="_blank" class="mono" style="font-size:var(--fs-mono-xs);color:var(--signal);text-decoration:none;border-bottom:1px dashed var(--signal);cursor:pointer;opacity:0.85;transition:opacity .15s" @mouseenter="$el.style.opacity = '1'" @mouseleave="$el.style.opacity = '0.85'" x-text="apiKeyLinkText"></a>
        </div>
        <div style="position:relative">
          <input :type="showKey ? 'text' : 'password'" x-model="config.apiKey" :placeholder="config.apiKey ? i18n[lang].apiKeyPlaceholder : i18n[lang].apiKeyEmptyPlaceholder" />
          <button type="button" @click="showKey = !showKey" style="position:absolute;right:10px;top:50%;transform:translateY(-50%);background:transparent;border:0;color:var(--text-muted);font-family:var(--font-mono);font-size:var(--fs-mono-xs);cursor:pointer;" x-text="showKey ? 'HIDE' : 'SHOW'"></button>
        </div>
      </div>

      <div class="form-group">
        <label class="label" x-text="i18n[lang].baseUrlLabel"></label>
        <input type="text" x-model="config.baseUrl" @input="onBaseUrlChange()" :readonly="config.presetId !== 'custom'" :style="config.presetId !== 'custom' ? 'opacity:0.6;cursor:not-allowed' : ''" />
      </div>

      <div style="border-top:1px solid var(--line);margin-top:var(--space-lg);padding-top:var(--space-md)">
        <h3 class="label" style="margin-bottom:var(--space-md)" x-text="i18n[lang].advancedTitle"></h3>
        
        <div class="grid-2">
          <div class="form-group">
            <label class="label" x-text="i18n[lang].allowedDirsLabel"></label>
            <input type="text" x-model="config.allowedDirs" :placeholder="i18n[lang].allowedDirsPlaceholder" />
          </div>
          <div class="form-group">
            <label class="label" x-text="i18n[lang].maxImageBytesLabel"></label>
            <input type="number" min="1" x-model.number="config.maxImageBytes" />
          </div>
        </div>

        <div class="grid-2">
          <div class="form-group">
            <label class="label" x-text="i18n[lang].timeoutLabel"></label>
            <input type="number" min="1" x-model.number="config.timeoutMs" />
          </div>
          <div class="form-group">
            <label class="label" x-text="i18n[lang].maxTokensLabel"></label>
            <input type="number" min="1" x-model.number="config.maxTokens" />
          </div>
        </div>

        <div class="grid-2">
          <div class="form-group">
            <label class="label" x-text="i18n[lang].maxImagesLabel"></label>
            <input type="number" min="1" x-model.number="config.maxImages" />
          </div>
          <div class="form-group">
            <label class="label" x-text="i18n[lang].maxRetriesLabel"></label>
            <input type="number" min="0" x-model.number="config.maxRetries" />
          </div>
        </div>

        <div class="toggle-group">
          <div>
            <div class="label" style="color:var(--text-primary)" x-text="i18n[lang].debugTitle"></div>
            <div style="font-size:var(--fs-mono-xs);color:var(--text-muted)" x-text="i18n[lang].debugDesc"></div>
          </div>
          <input type="checkbox" x-model="config.debug" style="width:auto;cursor:pointer" />
        </div>

        <div class="toggle-group">
          <div>
            <div class="label" style="color:var(--text-primary)" x-text="i18n[lang].cacheTitle"></div>
            <div style="font-size:var(--fs-mono-xs);color:var(--text-muted)" x-text="i18n[lang].cacheDesc"></div>
          </div>
          <input type="checkbox" x-model="config.cache.enabled" style="width:auto;cursor:pointer" />
        </div>

        <div class="grid-2" x-show="config.cache.enabled" style="margin-top:var(--space-md)">
          <div class="form-group">
            <label class="label" x-text="i18n[lang].cacheMaxLabel"></label>
            <input type="number" min="0" x-model.number="config.cache.maxEntries" />
          </div>
          <div class="form-group">
            <label class="label" x-text="i18n[lang].cacheTtlLabel"></label>
            <input type="number" min="1" x-model.number="config.cache.ttlMs" />
          </div>
        </div>
      </div>

      <div style="margin-top:var(--space-lg);display:flex;justify-content:space-between;align-items:center">
        <span class="mono" style="font-size:var(--fs-mono-xs);color:var(--text-muted)" x-text="i18n[lang].configPathLabel + status.configPath"></span>
        <div style="display:flex;gap:var(--space-sm)">
          <button class="btn" style="background:var(--surface-3);color:var(--text-primary);border:1px solid var(--line)" @click="testConnection()" :disabled="testingConnection || saving">
            <span x-text="testingConnection ? i18n[lang].testingConnBtn : i18n[lang].testConnBtn"></span>
          </button>
          <button class="btn" @click="saveConfig()" :disabled="saving || testingConnection">
            <span x-text="saving ? i18n[lang].committingBtn : i18n[lang].commitBtn"></span>
          </button>
        </div>
      </div>
    </div>
  </div>

  <!-- PLAYGROUND TAB -->
  <div x-show="activeTab === 'playground'">
    <div class="card">
      <div class="card-header">
        <h2 class="card-title" x-text="i18n[lang].playgroundTitle"></h2>
      </div>

      <div class="playground-split">
        <div>
          <div class="form-group">
            <label class="label" x-text="i18n[lang].fileLabel"></label>
            <div class="dropzone" 
                 @dragover.prevent="dragOver = true" 
                 @dragleave.prevent="dragOver = false"
                 @drop.prevent="handleDrop($event)"
                 :style="dragOver ? 'border-color:var(--signal);background:var(--surface-3)' : ''"
                 @click="$refs.fileInput.click()">
              <input type="file" x-ref="fileInput" style="display:none" accept="image/*" @change="handleFileSelect($event)" />
              <div class="mono" style="font-size:var(--fs-mono-sm); white-space: pre-wrap;" x-text="imageName || i18n[lang].dropzonePlaceholder"></div>
              <img x-show="imagePreview" :src="imagePreview" class="dropzone-img" />
            </div>
          </div>

          <div class="form-group">
            <label class="label" x-text="i18n[lang].urlLabel"></label>
            <input type="text" x-model="playground.imageUrl" :placeholder="i18n[lang].urlPlaceholder" @input="onUrlInput()" />
          </div>

          <div class="form-group">
            <label class="label" x-text="i18n[lang].promptLabel"></label>
            <textarea x-model="playground.prompt" rows="4" :placeholder="i18n[lang].promptPlaceholder"></textarea>
          </div>

          <div class="form-group" x-show="!status.ready" style="padding:var(--space-sm);border:1px solid var(--warn);background:rgba(245,161,66,0.1);border-radius:var(--radius);margin-bottom:var(--space-md)">
            <div style="font-size:var(--fs-mono-xs);color:var(--warn);line-height:1.4" x-text="i18n[lang].notLiveWarning"></div>
          </div>

          <button class="btn" style="width:100%" @click="runTest()" :disabled="testing || (!imagePreview && !playground.imageUrl)">
            <span x-text="testing ? i18n[lang].analyzingBtn : i18n[lang].analyzeBtn"></span>
          </button>
        </div>

        <div>
          <label class="label" x-text="i18n[lang].outputLabel"></label>
          <div class="result-box" x-text="testing ? i18n[lang].outputAwaitingResponse : (testResult || i18n[lang].outputAwaitingInput)"></div>
        </div>
      </div>
    </div>
  </div>

  <!-- ACCESS GUIDE TAB -->
  <div x-show="activeTab === 'guide'">
    <div class="card">
      <div class="card-header">
        <h2 class="card-title" x-text="i18n[lang].patchBayTitle"></h2>
      </div>
      <p style="color:var(--text-secondary);font-size:var(--fs-mono-sm);margin-bottom:var(--space-md);line-height:1.6" x-text="i18n[lang].patchBayDesc"></p>

      <div class="form-group">
        <label class="label" style="display:inline-block;margin-bottom:var(--space-xs)" x-text="i18n[lang].selectTargetLabel"></label>
        <div style="display:flex;gap:var(--space-sm);margin-bottom:var(--space-md)">
          <button class="tab-btn" :class="exportAgent === 'claude' && 'active'" @click="exportAgent = 'claude'; fetchExport()">Claude Desktop</button>
          <button class="tab-btn" :class="exportAgent === 'cursor' && 'active'" @click="exportAgent = 'cursor'; fetchExport()">Cursor</button>
          <button class="tab-btn" :class="exportAgent === 'cline' && 'active'" @click="exportAgent = 'cline'; fetchExport()">Cline</button>
        </div>
      </div>

      <div class="form-group">
        <label class="label" x-text="exportData ? exportData.note : ''"></label>
        <div style="position:relative">
          <code-block>
            <pre style="margin:0;white-space:pre-wrap" x-html="highlightedExport"></pre>
          </code-block>
          <button class="copy-btn" @click="copySnippet()" x-text="copied ? i18n[lang].copiedBtn : i18n[lang].copyBtn"></button>
        </div>
      </div>
    </div>
  </div>
</div>

<script>
function consoleApp() {
  return {
    lang: localStorage.getItem('vp-lang') || 'zh',
    activeTab: 'config',
    theme: 'dark',
    alert: { msg: '', type: 'success' },
    showKey: false,
    saving: false,
    testingConnection: false,
    presets: [],
    config: {
      presetId: 'qwen3-vl-flash',
      model: 'qwen3-vl-flash',
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      apiKey: '',
      allowedDirs: '',
      maxImageBytes: 20971520,
      timeoutMs: 60000,
      maxTokens: 2048,
      maxImages: 8,
      maxRetries: 2,
      debug: false,
      cache: { enabled: true, maxEntries: 32, ttlMs: 1800000 }
    },
    status: { ready: false, configPath: '' },
    
    // Playground states
    dragOver: false,
    imageName: '',
    imagePreview: '',
    playground: {
      imageBytes: '', // base64
      imageUrl: '',
      prompt: 'Describe this image in detail.'
    },
    testing: false,
    testResult: '',

    // Export guide states
    exportAgent: 'claude',
    exportData: null,
    copied: false,

    // Translation dictionary
    i18n: {
      zh: {
        subtitle: '图像理解配置控制台',
        credentialsTitle: '信号链 // 模型与凭证',
        statusLabel: '状态:',
        statusLive: '运行中',
        statusUnconfigured: '待配置',
        presetLabel: '模型预设',
        presetCustom: '自定义模型预设',
        customModelLabel: '自定义模型 ID',
        apiKeyLabel: 'API 密钥 (API Key)',
        apiKeyPlaceholder: '已安全保存 · 输入新密钥以覆盖',
        apiKeyEmptyPlaceholder: '在此粘贴您的 API 密钥',
        baseUrlLabel: '请求网址 (Base URL)',
        advancedTitle: '高级配置',
        allowedDirsLabel: '允许访问的本地目录 (以逗号分隔)',
        allowedDirsPlaceholder: '例如: /path/to/project, /another/path',
        maxImageBytesLabel: '单张图片大小限制 (Bytes)',
        timeoutLabel: '请求超时时间 (毫秒)',
        maxTokensLabel: '最大输出 Token 数 (Max Tokens)',
        maxImagesLabel: '单次最大分析图片数',
        maxRetriesLabel: '失败自动重试次数',
        debugTitle: '调试模式 (Debug Mode)',
        debugDesc: '在标准错误输出 (process.stderr) 中打印详细调试日志',
        cacheTitle: '启用缓存 (Cache)',
        cacheDesc: '对完全相同的图像和提示词请求进行进程内缓存 (不占用磁盘)',
        cacheMaxLabel: '缓存最大条目数',
        cacheTtlLabel: '缓存有效期 TTL (毫秒)',
        configPathLabel: '配置文件路径: ',
        commitBtn: '▸ 保存并应用配置',
        committingBtn: '正在提交...',
        testConnBtn: '⚡ 测试连接',
        testingConnBtn: '测试中...',
        testSuccessMsg: '连接测试成功！模型回复："',
        testFailMsg: '连接测试失败：',
        
        // Playground
        playgroundTitle: '信号测试工作台 // SIGNAL PLAYGROUND',
        fileLabel: '图片来源文件',
        dropzonePlaceholder: '拖拽图片到这里，或点击选择图片\\n(支持 JPG, PNG, WEBP, GIF, BMP)',
        urlLabel: '或输入公开图片 URL',
        urlPlaceholder: 'https://example.com/image.png',
        promptLabel: '提示词 (Prompt)',
        promptPlaceholder: '详细描述这张图片，或提出具体问题...',
        notLiveWarning: '⚠ 通道尚未就绪 — 请先在 CONFIG 选项卡中配置并保存 API 密钥。',
        analyzeBtn: '▸ 开始分析图像',
        analyzingBtn: '正在分析中...',
        outputLabel: '分析结果输出',
        outputAwaitingResponse: '正在等待 API 响应中...',
        outputAwaitingInput: '等待图像分析输入...',
        
        // Patch Bay
        patchBayTitle: '路由配置接入 // PATCH BAY',
        patchBayDesc: '保存配置后，客户端（如 Claude Desktop、Cursor）的 MCP 配置将变得极简，无需在客户端写入复杂的 env 环境变量，VisionPower 会自动从本地加载配置。',
        selectTargetLabel: '选择集成目标',
        copyBtn: '⧉ 复制配置',
        copiedBtn: '已复制 ✓',
      },
      en: {
        subtitle: 'Image Understanding Console',
        credentialsTitle: 'SIGNAL CHAIN // MODEL & CREDENTIALS',
        statusLabel: 'STATUS:',
        statusLive: 'LIVE',
        statusUnconfigured: 'UNCONFIGURED',
        presetLabel: 'Model Preset',
        presetCustom: 'Custom Model Preset',
        customModelLabel: 'Custom Model ID',
        apiKeyLabel: 'API Key',
        apiKeyPlaceholder: 'stored · retype to overwrite',
        apiKeyEmptyPlaceholder: 'paste api key here',
        baseUrlLabel: 'Base URL (API Endpoint)',
        advancedTitle: 'ADVANCED CONFIGURATION',
        allowedDirsLabel: 'Allowed Local Directories (comma-separated)',
        allowedDirsPlaceholder: 'e.g. /path/to/project, /another/path',
        maxImageBytesLabel: 'Max Image Bytes',
        timeoutLabel: 'Request Timeout (ms)',
        maxTokensLabel: 'Max Tokens',
        maxImagesLabel: 'Max Images',
        maxRetriesLabel: 'Max Retries',
        debugTitle: 'Debug Mode',
        debugDesc: 'Print debug information to process.stderr',
        cacheTitle: 'Cache Enabled',
        cacheDesc: 'Process-local cache for identical image description calls',
        cacheMaxLabel: 'Cache Max Entries',
        cacheTtlLabel: 'Cache TTL (ms)',
        configPathLabel: 'Config path: ',
        commitBtn: '▸ COMMIT CONFIG',
        committingBtn: 'COMMITTING...',
        testConnBtn: '⚡ TEST CONNECTION',
        testingConnBtn: 'TESTING...',
        testSuccessMsg: 'Connection test successful! Model response: "',
        testFailMsg: 'Connection test failed: ',
        
        // Playground
        playgroundTitle: 'SIGNAL PLAYGROUND // TESTING WORKSTATION',
        fileLabel: 'Image Source File',
        dropzonePlaceholder: 'Drag & Drop Image or Click to Select\\n(JPG, PNG, WEBP, GIF, BMP)',
        urlLabel: 'Or Public Image URL',
        urlPlaceholder: 'https://example.com/image.png',
        promptLabel: 'Prompt (Query)',
        promptPlaceholder: 'Describe this image in detail, or ask a specific question...',
        notLiveWarning: '⚠ CHANNEL NOT LIVE — You must complete and save the config tab before testing. Or paste a temporary key in the config tab first.',
        analyzeBtn: '▸ ANALYZE IMAGE',
        analyzingBtn: 'ANALYZING...',
        outputLabel: 'Analysis output',
        outputAwaitingResponse: 'Awaiting API response...',
        outputAwaitingInput: 'Awaiting image analysis input...',
        
        // Patch Bay
        patchBayTitle: 'PATCH BAY // ROUTING CONFIGURATION',
        patchBayDesc: 'Once configured, you don\\\'t need to specify API keys or endpoints in environment variables. Start this MCP server directly in your agent configuration, and it will load settings from the local configuration file.',
        selectTargetLabel: 'Select Integration Target',
        copyBtn: '⧉ COPY',
        copiedBtn: 'COPIED ✓',
      }
    },

    async init() {
      // Load current theme
      this.theme = localStorage.getItem('vp-theme') || 'dark';
      document.documentElement.setAttribute('data-theme', this.theme);
      
      // Presets must be loaded first so that loadConfig() can correctly
      // resolve whether the stored model is a known preset or a custom one.
      await this.loadPresets();
      await this.loadConfig();
      await this.loadStatus();
      await this.fetchExport();
    },

    toggleTheme() {
      this.theme = this.theme === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', this.theme);
      localStorage.setItem('vp-theme', this.theme);
    },

    toggleLang() {
      this.lang = this.lang === 'zh' ? 'en' : 'zh';
      localStorage.setItem('vp-lang', this.lang);
      // Fetch export guide code snippet again because target notes are localized
      this.fetchExport();
    },

    async loadConfig() {
      try {
        const res = await fetch('/api/config');
        if (!res.ok) throw new Error('Failed to load configuration');
        const data = await res.json();
        
        // Handle array to comma-separated string mapping for local directory inputs
        let dirsStr = '';
        if (data.allowedDirs) {
          dirsStr = Array.isArray(data.allowedDirs) ? data.allowedDirs.join(', ') : data.allowedDirs;
        }

        // Resolve presetId: if the stored model matches a known preset use that model
        // as the preset ID, otherwise fall back to 'custom' so the dropdown shows
        // the custom input field instead of a blank/mismatched option.
        const storedModel = data.model || 'qwen3-vl-flash';
        const knownModels = this.presets.map(p => p.model);
        const resolvedPresetId = knownModels.includes(storedModel) ? storedModel : 'custom';

        this.config = {
          presetId: resolvedPresetId,
          model: storedModel,
          baseUrl: data.baseUrl || '',
          apiKey: data.apiKey || '',
          allowedDirs: dirsStr,
          maxImageBytes: data.maxImageBytes !== undefined ? data.maxImageBytes : 20971520,
          timeoutMs: data.timeoutMs !== undefined ? data.timeoutMs : 60000,
          maxTokens: data.maxTokens !== undefined ? data.maxTokens : 2048,
          maxImages: data.maxImages !== undefined ? data.maxImages : 8,
          maxRetries: data.maxRetries !== undefined ? data.maxRetries : 2,
          debug: !!data.debug,
          cache: {
            enabled: data.cache ? !!data.cache.enabled : true,
            maxEntries: data.cache?.maxEntries !== undefined ? data.cache.maxEntries : 32,
            ttlMs: data.cache?.ttlMs !== undefined ? data.cache.ttlMs : 1800000
          }
        };
      } catch (err) {
        this.showAlert(err.message, 'error');
      }
    },

    async loadPresets() {
      try {
        const res = await fetch('/api/presets');
        if (res.ok) {
          this.presets = await res.json();
        }
      } catch (err) {
        console.error('Failed to load presets:', err);
      }
    },

    async loadStatus() {
      try {
        const res = await fetch('/api/status');
        if (res.ok) {
          this.status = await res.json();
        }
      } catch (err) {
        console.error('Failed to load status:', err);
      }
    },

    onPresetChange() {
      if (this.config.presetId !== 'custom') {
        const selected = this.presets.find(p => p.model === this.config.presetId);
        if (selected) {
          this.config.model = selected.model;
          this.config.baseUrl = selected.baseUrl;
          this.onBaseUrlChange();
        }
      }
    },

    onBaseUrlChange() {
      const url = this.config.baseUrl;
      const rememberedKey = this.getKeyFromMemory(url);
      if (rememberedKey) {
        this.config.apiKey = rememberedKey;
      } else {
        this.config.apiKey = '';
      }
    },

    getKeyFromMemory(url) {
      if (!url) return '';
      try {
        const mapping = JSON.parse(localStorage.getItem('vp-keys-by-url') || '{}');
        return mapping[url] || '';
      } catch {
        return '';
      }
    },

    saveKeyToMemory(url, key) {
      if (!url || !key || key.includes('****')) return;
      try {
        const mapping = JSON.parse(localStorage.getItem('vp-keys-by-url') || '{}');
        mapping[url] = key;
        localStorage.setItem('vp-keys-by-url', JSON.stringify(mapping));
      } catch {}
    },

    showAlert(msg, type = 'success') {
      this.alert = { msg, type };
      setTimeout(() => {
        if (this.alert.msg === msg) this.alert.msg = '';
      }, 5000);
    },

    async saveConfig() {
      this.saving = true;
      try {
        // Exclude the UI-only presetId field — it is not a valid config key
        // and must never be persisted to config.json.
        const { presetId, ...configFields } = this.config;
        const payload = { ...configFields };
        
        // Convert comma separated string to array
        payload.allowedDirs = this.config.allowedDirs
          ? this.config.allowedDirs.split(',').map(s => s.trim()).filter(Boolean)
          : [];

        // Save key to local browser storage memory mapping if it is unmasked
        this.saveKeyToMemory(payload.baseUrl, payload.apiKey);

        const res = await fetch('/api/config', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        if (!res.ok) {
          const errData = await res.json();
          throw new Error(errData.error || 'Failed to save configuration');
        }
        
        await this.loadConfig();
        await this.loadStatus();
        this.showAlert('Configuration committed successfully!', 'success');
      } catch (err) {
        this.showAlert(err.message, 'error');
      } finally {
        this.saving = false;
      }
    },

    async testConnection() {
      this.testingConnection = true;
      try {
        const body = {
          apiKey: this.config.apiKey,
          baseUrl: this.config.baseUrl,
          model: this.config.model,
        };
        const res = await fetch('/api/test-connection', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        });
        const data = await res.json();
        if (!res.ok) {
          throw new Error(data.error || 'Connection test failed');
        }
        this.showAlert(this.i18n[this.lang].testSuccessMsg + data.message + '"', 'success');
      } catch (err) {
        const cleanErr = err.message.replace(/^Connection test failed:? ?/i, '');
        this.showAlert(this.i18n[this.lang].testFailMsg + cleanErr, 'error');
      } finally {
        this.testingConnection = false;
      }
    },

    // Playground files
    handleFileSelect(e) {
      const file = e.target.files[0];
      if (file) this.processImage(file);
    },
    
    handleDrop(e) {
      this.dragOver = false;
      const file = e.dataTransfer.files[0];
      if (file) this.processImage(file);
    },

    processImage(file) {
      if (!file.type.startsWith('image/')) {
        this.showAlert('File must be an image', 'error');
        return;
      }
      this.imageName = file.name;
      this.playground.imageUrl = ''; // clear url input if file uploaded

      const reader = new FileReader();
      reader.onload = (e) => {
        this.imagePreview = e.target.result;
        // strip data uri prefix for API
        const base64Str = e.target.result.split(',')[1];
        this.playground.imageBytes = base64Str;
      };
      reader.readAsDataURL(file);
    },

    onUrlInput() {
      if (this.playground.imageUrl) {
        this.imagePreview = this.playground.imageUrl;
        this.imageName = 'Image URL';
        this.playground.imageBytes = '';
      } else {
        this.imagePreview = '';
        this.imageName = '';
      }
    },

    async runTest() {
      this.testing = true;
      this.testResult = 'Analyzing image...';
      try {
        const body = {
          prompt: this.playground.prompt,
        };
        if (this.playground.imageBytes) {
          body.image_base64 = this.playground.imageBytes;
        } else if (this.playground.imageUrl) {
          body.image_url = this.playground.imageUrl;
        }

        const res = await fetch('/api/test', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        });
        
        const data = await res.json();
        if (!res.ok) {
          throw new Error(data.error || 'Request failed');
        }
        
        this.testResult = data.result;
      } catch (err) {
        this.testResult = 'Error: ' + err.message;
        this.showAlert('Testing failed: ' + err.message, 'error');
      } finally {
        this.testing = false;
      }
    },

    async fetchExport() {
      try {
        const res = await fetch(\`/api/export?agent=\${this.exportAgent}\`);
        if (res.ok) {
          this.exportData = await res.json();
        }
      } catch (err) {
        console.error('Failed to fetch export configuration:', err);
      }
    },

    get exportText() {
      return this.exportData ? JSON.stringify(this.exportData.config, null, 2) : '';
    },

    get apiKeyLink() {
      const model = this.config.model || '';
      if (model.startsWith('gpt-')) {
        return 'https://platform.openai.com/api-keys';
      }
      if (model.startsWith('minimax-')) {
        return 'https://platform.minimaxi.com/user-center/basic-information/interface-key';
      }
      return 'https://bailian.console.aliyun.com/cn-beijing';
    },

    get apiKeyLinkText() {
      const model = this.config.model || '';
      if (this.lang === 'zh') {
        if (model.startsWith('gpt-')) return '获取 OpenAI API Key ↗';
        if (model.startsWith('minimax-')) return '获取 MiniMax API Key ↗';
        return '获取阿里云百炼 API Key ↗';
      } else {
        if (model.startsWith('gpt-')) return 'Get OpenAI API Key ↗';
        if (model.startsWith('minimax-')) return 'Get MiniMax API Key ↗';
        return 'Get Aliyun Bailian API Key ↗';
      }
    },

    get highlightedExport() {
      if (!this.exportText) return '';
      const esc = this.exportText.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
      return esc.replace(
        /("(?:[^"\\\\\\\\]|\\\\\\\\.)*")(\\\\s*:)|("(?:[^"\\\\\\\\]|\\\\\\\\.)*")|(-?\\\\d+(?:\\\\.\\\\d+)?)|([{}[\\\\\]])/g,
        (m, key, colon, str, num, punc) => {
          if (key) return '<span style="color:var(--signal)">' + key + '</span>' + colon;
          if (str) return '<span style="color:var(--text-secondary)">' + str + '</span>';
          if (num) return '<span style="color:var(--warn)">' + num + '</span>';
          if (punc) return '<span style="color:var(--text-muted)">' + punc + '</span>';
          return m;
        }
      );
    },

    copySnippet() {
      if (!this.exportText) return;
      navigator.clipboard.writeText(this.exportText).then(() => {
        this.copied = true;
        setTimeout(() => this.copied = false, 2000);
      });
    }
  };
}
</script>
</body>
</html>
`;
