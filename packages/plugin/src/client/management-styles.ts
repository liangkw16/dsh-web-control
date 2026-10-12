/** Every selector is scoped to the plugin slot; host typography stays owned by DSH. */
export const managementStyles = `
[data-web-control-management] { --wc-bg: var(--dsw-alias-bg-layer-1, var(--background, #fff)); --wc-fg: var(--dsw-alias-label-primary, var(--foreground, #202124)); --wc-muted: var(--dsw-alias-label-tertiary, var(--muted-foreground, #75777c)); --wc-line: var(--dsw-alias-border-l3, var(--border, #e5e5e8)); --wc-wash: var(--dsw-alias-settings-card-fill, var(--muted, #f6f6f7)); width:100%; min-width:0; container: web-control / inline-size; }
[data-web-control-management] .wc-panel { font:inherit; font-size:14px; line-height:1.5; color:var(--wc-fg); width:100%; max-width:760px; min-width:0; box-sizing:border-box; }
[data-web-control-management] .wc-panel * { box-sizing:border-box; }
[data-web-control-management] .wc-panel h2 { font-size:20px; font-weight:600; margin:0 0 4px; }
[data-web-control-management] .wc-panel h3 { font-size:16px; margin:0 0 6px; font-weight:600; }
[data-web-control-management] .wc-panel p { font-size:14px; color:var(--wc-muted); margin:0; line-height:1.6; }
[data-web-control-management] .wc-heading { display:flex; align-items:flex-start; gap:14px; margin-bottom:22px; }
[data-web-control-management] .wc-heading > div { flex:1; min-width:0; }
[data-web-control-management] .wc-icon { width:46px; height:46px; flex-shrink:0; display:grid; place-items:center; border:1px solid var(--wc-line); background:var(--wc-wash); border-radius:12px; }
[data-web-control-management] .wc-panel button,[data-web-control-management] .wc-button { font:inherit; font-size:14px; line-height:1.4; color:var(--wc-fg); background:var(--wc-bg); border:1px solid var(--wc-line); border-radius:8px; padding:9px 14px; min-height:40px; cursor:pointer; text-decoration:none; display:inline-flex; justify-content:center; align-items:center; }
[data-web-control-management] .wc-panel button:hover,[data-web-control-management] .wc-button:hover { background:var(--wc-wash); }
[data-web-control-management] .wc-panel button:disabled { opacity:.45; cursor:default; }
[data-web-control-management] .wc-panel :focus-visible { outline:var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--wc-fg)); outline-offset:3px; }
[data-web-control-management] .wc-status { display:flex; align-items:center; gap:8px; padding:12px 14px; background:var(--wc-wash); border-radius:10px; margin-bottom:20px; }
[data-web-control-management] .wc-dot { width:8px; height:8px; border-radius:50%; background:#93959a; flex-shrink:0; }
[data-web-control-management] .wc-ready { background:#3c9970; } [data-web-control-management] .wc-connecting,[data-web-control-management] .wc-syncing { background:#d58a28; }
[data-web-control-management] .wc-status-note { margin-left:auto; color:var(--wc-muted); font-size:13px; }
[data-web-control-management] .wc-connect { padding:20px; border:1px solid var(--wc-line); border-radius:12px; }
[data-web-control-management] .wc-qr { display:grid; place-items:center; padding:22px; margin:18px 0; background:var(--wc-wash); border:1px dashed var(--wc-line); border-radius:10px; }
[data-web-control-management] .wc-qr canvas { max-width:100%; height:auto!important; border:10px solid white; border-radius:10px; }
[data-web-control-management] .wc-link-actions { display:flex; justify-content:center; flex-wrap:wrap; gap:10px; margin-bottom:12px; }
[data-web-control-management] .wc-panel .wc-primary { background:var(--wc-fg); border-color:var(--wc-fg); color:var(--wc-bg); }
[data-web-control-management] .wc-panel .wc-primary:hover,[data-web-control-management] .wc-panel .wc-primary:focus-visible { background:var(--wc-fg); color:var(--wc-bg); }
[data-web-control-management] .wc-panel input { font:inherit; width:100%; min-width:0; min-height:40px; padding:8px 12px; border:1px solid var(--wc-line); color:var(--wc-fg); background:var(--wc-bg); border-radius:7px; }
[data-web-control-management] .wc-link { font-size:12px!important; color:var(--wc-muted)!important; }
[data-web-control-management] .wc-feedback { min-height:24px; margin-top:10px!important; text-align:center; font-size:12px!important; }
[data-web-control-management] .wc-setup { margin-top:18px; border:1px solid var(--wc-line); border-radius:10px; padding:14px; }
[data-web-control-management] .wc-actions { display:flex; flex-wrap:wrap; gap:8px; margin:14px 0 10px; }
[data-web-control-management] .wc-setup p { font-size:12px; }
[data-web-control-management] .wc-secondary { display:flex; justify-content:space-between; gap:10px; margin:18px 0; }
[data-web-control-management] .wc-panel .wc-danger { color:var(--dsw-alias-state-error-primary, #b54c45); }
[data-web-control-management] .wc-error { color:var(--dsw-alias-state-error-primary, #b54c45)!important; padding:12px 0; }
[data-web-control-management] .wc-panel footer { margin-top:18px; } [data-web-control-management] .wc-panel footer p { font-size:12px; }
[data-web-control-management] .wc-narrow-help { display:none; margin:12px 0; }
[data-web-control-management] .wc-setup-review { border-top:1px solid var(--wc-line); padding-top:14px; }
[data-web-control-management] .wc-setup .wc-replace-choice { display:flex; align-items:flex-start; gap:8px; margin-top:12px; font-size:13px; }
[data-web-control-management] .wc-panel .wc-replace-choice input { width:16px; min-height:16px; margin-top:2px; flex-shrink:0; }
[data-web-control-management] .wc-panel .wc-settings-link { border:0; padding:4px 0; color:var(--wc-muted); font-size:12px; background:transparent; }
[data-web-control-management] .wc-panel button,[data-web-control-management] .wc-button { max-width:100%; white-space:normal; overflow-wrap:anywhere; }
[data-web-control-management] .wc-panel p,[data-web-control-management] .wc-panel h2,[data-web-control-management] .wc-panel h3,[data-web-control-management] .wc-setup { overflow-wrap:anywhere; }
@container web-control (max-width:420px) { [data-web-control-management] .wc-heading { gap:10px; } [data-web-control-management] .wc-status { flex-wrap:wrap; } [data-web-control-management] .wc-status-note { width:100%; margin-left:16px; } [data-web-control-management] .wc-connect { padding:14px; } [data-web-control-management] .wc-qr { padding:12px; } [data-web-control-management] .wc-secondary { flex-wrap:wrap; } }
@container web-control (max-width:240px) { [data-web-control-management] .wc-icon { display:none; } [data-web-control-management] .wc-connect,[data-web-control-management] .wc-setup,[data-web-control-management] .wc-status { padding:10px; } [data-web-control-management] .wc-qr { display:none; } [data-web-control-management] .wc-narrow-help { display:block; } [data-web-control-management] .wc-status-note { margin-left:0; } [data-web-control-management] .wc-panel button,[data-web-control-management] .wc-button { padding:8px; font-size:13px; } }
@media(prefers-color-scheme:dark) { [data-web-control-management] { --wc-bg:var(--dsw-alias-bg-layer-1,var(--background,#202124)); --wc-fg:var(--dsw-alias-label-primary,var(--foreground,#ededee)); --wc-muted:var(--dsw-alias-label-tertiary,var(--muted-foreground,#a4a5ab)); --wc-line:var(--dsw-alias-border-l3,var(--border,#3b3c40)); --wc-wash:var(--dsw-alias-settings-card-fill,var(--muted,#292a2e)); } }
`
