import { STORY_PALETTE_DECLS } from "@plugins/apps/plugins/website/plugins/pages/plugins/story/core";

/* The figures' stylesheet and icons, ported verbatim from the prototype's `claude.js`
   (`proto-1794207359-w7ez6h`).

   Colours: the Claude app's window (`.cl`) is a picture of that app in its light theme, so its palette is
   the picture's own — declared once, on `.cl`, the same in light and dark mode, like the iceberg and the
   zoom elsewhere on the site. The feature lines under it and the native data view (`.cl.native`, the
   Notion-like reading list drawn straight on the page) read the story palette, i.e. the site's theme. */

export const EASE = "cubic-bezier(.2,.7,.2,1)";
/** EASE's control points, for a scroll glided on the same curve */
export const EASE_POINTS = [0.2, 0.7, 0.2, 1] as const;

export const CSS = `
:host{${STORY_PALETTE_DECLS}}
:host{display:block}
*{box-sizing:border-box}
button{font:inherit;color:inherit;background:none;border:0;padding:0;margin:0;cursor:pointer;text-align:left;letter-spacing:inherit}
input,textarea{font:inherit;color:inherit;letter-spacing:inherit}
svg{display:block;flex:none}
.fig{max-width:1000px;margin:0 auto;container-type:inline-size;container-name:fig}
.cl{--bg:#fff;--sb:#fafafa;--t0:rgba(0,0,0,.9);--t2:#3b3b3b;--t4:#787878;--t5:#a0a0a0;--line:rgba(0,0,0,.08);--line2:rgba(0,0,0,.12);
  --hov:rgba(0,0,0,.04);--sel:rgba(0,0,0,.07);--acc:#2a73c6;--acc-soft:rgba(42,115,198,.1);--clay:#d97757;--danger:#c4463c;
  --sans:"Anthropic Sans",ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;
  --serif:"Anthropic Serif","Source Serif 4","Tiempos Text",Georgia,"Times New Roman",serif;
  font:430 14px/20px var(--sans);color:var(--t0);-webkit-font-smoothing:antialiased;text-align:left;letter-spacing:0;color-scheme:light}

/* ---------- window ---------- */
.frame{position:relative;display:grid;grid-template-columns:var(--sbw,268px) minmax(0,1fr);height:640px;border-radius:14px;overflow:hidden;background:var(--bg);
  box-shadow:0 0 0 1px rgba(0,0,0,.1),0 22px 50px -24px rgba(0,0,0,.28);transition:grid-template-columns .28s ${EASE}}
.frame.col{--sbw:52px}
.frame.solo{grid-template-columns:minmax(0,1fr);height:var(--fh,560px)}

/* ---------- sidebar ---------- */
.sb{display:flex;flex-direction:column;min-width:0;min-height:0;background:var(--sb);border-right:1px solid var(--line);overflow:hidden;position:relative}
.sbh{height:48px;display:flex;align-items:center;gap:4px;padding:0 12px;flex:none}
.ib{width:28px;height:28px;border-radius:8px;display:grid;place-items:center;color:var(--t2);flex:none;transition:background .15s,color .15s}
.ib:hover{background:var(--hov);color:var(--t0)}.ib.on{background:var(--sel);color:var(--t0)}
.ib.has{color:var(--acc);background:var(--acc-soft)}
.word{font:500 20px/24px var(--serif);letter-spacing:-.015em;color:var(--t0);padding:0 4px;white-space:nowrap;border-radius:6px}
.nav{padding:0 8px 4px;display:flex;flex-direction:column;gap:2px;flex:none}
.ni{display:flex;align-items:center;gap:10px;height:32px;padding:0 9px;border-radius:8px;white-space:nowrap;font-weight:450;transition:background .12s}
.ni:hover{background:var(--hov)}.ni.on{background:var(--sel)}
.ni svg{color:var(--t2)}
.sbb{flex:1;min-height:0;overflow-y:auto;overflow-x:hidden;padding:0 8px 14px;scrollbar-width:thin;scrollbar-color:rgba(0,0,0,.15) transparent}
.sech{position:relative;display:flex;align-items:center;height:28px;margin:12px 0 2px;border-radius:8px;transition:background .12s}
.sech:hover,.sech.mon{background:var(--hov)}
.shb{flex:1;min-width:0;display:flex;align-items:center;gap:4px;height:100%;font:520 12px/20px var(--sans);color:var(--t4);padding:4px 0 4px 9px;border-radius:8px;transition:color .12s}
.sech:hover .shb,.sech.mon .shb{color:var(--t0)}
.shb svg{opacity:.75}
.sfb{position:absolute;right:2px;top:2px;width:24px;height:24px;border-radius:6px;display:grid;place-items:center;color:var(--t0);opacity:0;transition:opacity .12s,background .12s,color .12s}
.sech:hover .sfb,.sfb.on,.sfb.has,.sfb:focus-visible{opacity:1}
.sfb:hover,.sfb.on{background:var(--sel)}
.sfb.has{color:var(--acc)}
@keyframes fresh{0%{background:var(--acc-soft);opacity:0;transform:translateY(-6px)}18%{opacity:1;transform:none}60%{background:var(--acc-soft)}}
.t{flex:1;min-width:0;overflow:hidden;white-space:nowrap;-webkit-mask-image:linear-gradient(90deg,#000 calc(100% - 22px),transparent);mask-image:linear-gradient(90deg,#000 calc(100% - 22px),transparent)}
.va{display:flex;align-items:center;height:32px;width:100%;padding:0 9px;border-radius:8px;color:var(--t4);margin-top:2px}
.va:hover{background:var(--hov);color:var(--t2)}
.acct{flex:none;border-top:1px solid var(--line);height:52px;display:flex;align-items:center;gap:9px;padding:0 14px;white-space:nowrap;cursor:default;user-select:none}
.av{width:24px;height:24px;border-radius:50%;background:#c4554d;color:#fff;font:600 11.5px/1 var(--sans);display:grid;place-items:center;flex:none}
.acct .pl{color:var(--t4)}
.frame.col .word,.frame.col .ni span,.frame.col .sbb,.frame.col .sbdv,.frame.col .acct .nm{display:none}
.frame.col .sbh{padding:0 12px}
.frame.col .ni{width:36px;padding:0;justify-content:center}
.frame.col .acct{padding:0 14px}
.sbdv{flex:1;min-height:0;display:flex;flex-direction:column;position:relative}
.sbdv::before{content:"";display:block;flex:none;height:1px;background:var(--line);margin:6px 17px 8px}
.sbdv [data-tb]{padding:0 8px 2px;flex:none}
.sbdv .sbb{padding-top:0}

/* ---------- main ---------- */
.main{min-width:0;min-height:0;position:relative;display:flex;flex-direction:column;background:var(--bg);container-type:inline-size;container-name:main}
.ms{flex:1;min-height:0;overflow-y:auto;overflow-x:hidden;scrollbar-width:thin;scrollbar-color:rgba(0,0,0,.18) transparent}
.page{max-width:960px;margin:0 auto;padding:30px 36px 56px}
.h1{font:500 24px/32px var(--serif);letter-spacing:-.01em;margin:0 0 14px;color:var(--t0)}
.bar{display:flex;align-items:center;flex-wrap:wrap;gap:8px;min-height:32px;margin-bottom:22px}
.tabs{display:flex;gap:2px;min-width:0}
.tab{height:28px;padding:0 12px;border-radius:8px;color:var(--t2);white-space:nowrap;transition:background .15s,color .15s;flex:none}
.tab:hover{background:var(--hov)}.tab.on{background:var(--sel);color:var(--t0)}
.tools{margin-left:auto;display:flex;align-items:center;gap:4px}
.tools .ib{color:var(--t0)}
.tools .ib:hover{background:var(--sel)}
.sfield{display:flex;align-items:center;gap:8px;height:32px;width:240px;max-width:100%;padding:0 4px 0 10px;border-radius:9px;background:#fff;color:var(--t4);
  box-shadow:inset 0 0 0 1px var(--acc),0 0 0 3px rgba(42,115,198,.14);animation:grow .18s ${EASE}}
.sfield input{flex:1;min-width:0;border:0;outline:0;background:none;color:var(--t0)}
.sfield input::placeholder{color:var(--t4)}
.sfield .x{width:22px;height:22px;border-radius:6px;display:grid;place-items:center}.sfield .x:hover{background:var(--sel)}
@keyframes grow{from{width:32px;opacity:.4}}
.btn{height:30px;padding:0 12px;border-radius:8px;background:rgba(0,0,0,.05);font-weight:450;white-space:nowrap;display:inline-flex;align-items:center;gap:6px;transition:background .15s}
.btn:hover{background:rgba(0,0,0,.09)}
.btn.dark{background:#1a1a1a;color:#fff}.btn.dark:hover{background:#333}
.btn.red{color:var(--danger)}

/* ---------- artifact cards / rows ---------- */
.ag{display:grid;grid-template-columns:repeat(auto-fill,minmax(172px,1fr));gap:18px}
.card{position:relative;border-radius:14px;background:#fff;box-shadow:0 0 0 1px var(--line2);overflow:hidden;transition:box-shadow .18s,transform .18s ${EASE}}
.card:hover{box-shadow:0 0 0 1px rgba(0,0,0,.2),0 4px 14px -6px rgba(0,0,0,.14)}
.cbtn{display:block;width:100%}
.th{position:relative;height:116px;overflow:hidden;font-size:9px}
.cf{display:flex;align-items:center;gap:8px;height:60px;padding:0 12px;background:#fcfcfc;border-top:1px solid var(--line)}
.cmeta{flex:1;min-width:0}
.ct{font-size:14px;line-height:20px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.cm{font-size:13px;line-height:17px;color:var(--t4);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.shi{color:var(--t4);display:flex}
.al{display:flex;flex-direction:column}
.arow{position:relative;display:flex;align-items:center;height:52px;border-radius:8px;transition:background .12s}
.arow:hover{background:var(--hov)}
.arb{flex:1;min-width:0;display:flex;align-items:center;gap:12px;height:100%;padding:0 4px 0 12px}
.ki{width:28px;height:28px;border-radius:7px;display:grid;place-items:center;flex:none}
.am{color:var(--t4);font-size:13px;white-space:nowrap;display:flex;align-items:center;gap:6px}

/* a book: its cover, standing on the card's tint (Notion's gallery cover) */
.bk{position:absolute;left:50%;top:1.6em;bottom:-.6em;width:54%;transform:translateX(-50%);border-radius:.3em .6em 0 0;padding:1.3em 1.1em;color:#fff;
  box-shadow:inset .45em 0 0 rgba(0,0,0,.12),0 .3em 1em rgba(0,0,0,.14);font:500 1.2em/1.2 var(--serif);overflow:hidden;text-wrap:balance}
.stars{color:var(--t4);letter-spacing:1px;font-size:12px}

/* artifact thumbnails, drawn in em so they scale */
.pgx{position:absolute;left:13%;right:13%;top:2.2em;bottom:0;background:#fff;border-radius:.7em .7em 0 0;box-shadow:0 0 0 1px rgba(0,0,0,.08),0 .2em .8em rgba(0,0,0,.05);
  padding:1.3em 1.4em;display:flex;flex-direction:column;gap:.6em;overflow:hidden}
.ln{display:block;height:.45em;border-radius:.3em;background:rgba(0,0,0,.1);width:100%;flex:none}
.ln.h{height:.85em;width:56%;background:rgba(0,0,0,.6)}.ln.s{width:68%}.ln.m{width:84%}
.pgx.sl{top:50%;bottom:auto;transform:translateY(-50%);aspect-ratio:16/9;border-radius:.6em;justify-content:center;padding:1.4em 1.8em;gap:.7em}
.pgx.sl .ln.h{width:62%;height:1.2em}
.pgx.sh{padding:0;gap:0;background-color:#fff;background-image:linear-gradient(rgba(0,0,0,.07) 1px,transparent 1px),linear-gradient(90deg,rgba(0,0,0,.07) 1px,transparent 1px);background-size:3.4em 1.7em}
.pgx.sh i{display:block;height:1.7em;flex:none}
.bars{flex:1;display:flex;align-items:flex-end;gap:.55em;border-bottom:1px solid rgba(0,0,0,.15);padding:0 .2em}
.bars s{flex:1;border-radius:.3em .3em 0 0;display:block;opacity:.85}
.nb{height:1.1em;border-radius:.35em;background:rgba(0,0,0,.06);flex:none}
.btns{display:flex;gap:.45em}.btns b{width:3.6em;height:1.2em;border-radius:.6em;background:rgba(0,0,0,.08)}
.cds{display:flex;gap:.5em;margin-top:auto;flex:none}.cds b{flex:1;height:2.8em;border-radius:.45em;background:rgba(0,0,0,.05)}
.pgx.wb{background-color:#fff;background-image:radial-gradient(rgba(0,0,0,.14) .08em,transparent .1em);background-size:1.2em 1.2em}
.pgx.wb b{position:absolute;width:3em;height:3em;border-radius:.2em;box-shadow:0 .15em .3em rgba(0,0,0,.08)}
.pgx.ot{align-items:center;justify-content:center;gap:1em}
.ring{width:4.6em;height:4.6em;border-radius:50%;border:.45em solid;border-right-color:rgba(0,0,0,.08)}
.pill{width:5em;height:1.3em;border-radius:.65em;background:rgba(0,0,0,.1)}
.fold{position:absolute;inset:0;display:grid;place-items:center;color:rgba(0,0,0,.35)}

/* ---------- recents (Claude's third list) ---------- */
.rl{border-top:1px solid var(--line)}
.rrow{display:flex;align-items:center;height:48px;border-bottom:1px solid var(--line);transition:background .12s}
.rrow:hover{background:var(--hov)}
.rrb{flex:1;min-width:0;display:flex;align-items:center;gap:12px;height:100%;padding:0 10px}
.rm{color:var(--t4);font-size:13px;white-space:nowrap}

/* ---------- spinner ---------- */
.more{display:flex;justify-content:center;align-items:center;min-height:52px;color:var(--t4);font-size:13px}
.spin{width:16px;height:16px;border-radius:50%;border:2px solid rgba(0,0,0,.1);border-top-color:var(--t2);animation:rot .7s linear infinite}
@keyframes rot{to{transform:rotate(360deg)}}
.end{text-align:center;color:var(--t5);font-size:12.5px;padding:14px 0 6px}
.empty{display:flex;flex-direction:column;align-items:center;gap:12px;padding:36px 0;color:var(--t4);font-size:13px}

/* ---------- menus, tooltip ---------- */
.layer{position:absolute;inset:0;pointer-events:none;z-index:30}
.menu{position:absolute;pointer-events:auto;min-width:200px;max-width:290px;background:#fff;border-radius:14px;padding:6px;
  box-shadow:inset 0 0 0 1px rgba(0,0,0,.08),0 8px 24px rgba(0,0,0,.12),0 2px 6px rgba(0,0,0,.06);animation:pop .14s ${EASE};transform-origin:top}
.menu.wide{min-width:236px}
@keyframes pop{from{opacity:0;transform:translateY(-3px) scale(.985)}}
.mh{font:520 12px/20px var(--sans);color:var(--t4);padding:4px 10px 2px}
.mi{display:flex;align-items:center;gap:10px;width:100%;min-height:28px;padding:4px 10px;border-radius:8px;white-space:nowrap;color:var(--t0)}
.mi:hover,.mi.hv{background:rgba(0,0,0,.05)}
.mi svg{color:var(--t2)}
.mi .ml{flex:1;min-width:0;display:flex;align-items:center;gap:8px}
.mi .mv{color:var(--t4);font-size:13px;line-height:17px}
.mi>svg:last-child{color:var(--t4)}
.menu.sub{min-width:132px}
.mi .kb{color:var(--t5);font-size:13px;min-width:10px;text-align:right}
.mi .ck{color:var(--acc)}
.mi .ck svg{color:var(--acc)}
/* a feature line's rows: what the hovered line is about, tinted like the line */
.msep{height:1px;background:var(--line);margin:4px 10px}
.badge{font-size:11px;line-height:16px;padding:0 6px;border-radius:6px;box-shadow:inset 0 0 0 1px var(--line2);color:var(--t4)}
.ren{width:100%;min-width:0;height:26px;border:0;outline:0;border-radius:6px;padding:0 6px;margin-left:-6px;background:#fff;box-shadow:inset 0 0 0 1px var(--acc),0 0 0 3px rgba(42,115,198,.14);font-size:inherit}
.msearch{display:flex;align-items:center;gap:8px;height:34px;margin:0 0 4px;padding:0 4px 0 10px;border-radius:9px;color:var(--t4);box-shadow:inset 0 0 0 1px var(--line2);transition:box-shadow .12s}
.msearch:focus-within{box-shadow:inset 0 0 0 1px var(--acc),0 0 0 3px rgba(42,115,198,.14)}
.msearch input{flex:1;min-width:0;border:0;outline:0;background:none;color:var(--t0)}
.msearch input::placeholder{color:var(--t4)}
.msearch .x{width:24px;height:24px;border-radius:6px;display:grid;place-items:center;color:var(--t4)}.msearch .x:hover{background:var(--sel);color:var(--t0)}.msearch .x[hidden]{display:none}

/* ---------- THE data view: a view button, a settings button, one body ---------- */
.vrow{display:flex;align-items:center;gap:4px;min-width:0}
.vbtn{flex:1;min-width:0;display:flex;align-items:center;gap:10px;height:32px;padding:0 7px 0 9px;border-radius:8px;font-weight:500;white-space:nowrap;transition:background .12s}
.vbtn:hover,.vbtn.on{background:var(--hov)}
.vbtn svg{color:var(--t2)}
.vbtn .vn{flex:none}
.vbtn .vq{min-width:0;overflow:hidden;text-overflow:ellipsis;color:var(--t4);font-weight:430}
.vbtn .vc{margin-left:auto;color:var(--t4);opacity:0;transition:opacity .12s,transform .18s ${EASE}}
.vbtn:hover .vc,.vbtn.on .vc{opacity:1}
.vbtn.on .vc{transform:rotate(180deg)}
.sbtn{background:rgba(0,0,0,.045)}
.vrow .ib{color:var(--t0)}
.vrow .ib:hover,.vrow .ib.on{background:var(--sel)}
.ib.has{color:var(--acc)!important;background:var(--acc-soft)}
.page .vrow{margin:0 0 18px -9px}
.page .vbtn{flex:0 1 auto;font-size:15px}
.page .vbtn .vc{margin-left:0}
.vrow .sp{flex:1}
.dvbody{container-type:inline-size;min-width:0}

/* the page's toolbar: Claude's own bar (.bar/.tabs/.tab/.tools/.ib), with the data view's controls in it */
.dvbar{flex-wrap:nowrap}
.dvbar .tabs{flex:0 0 auto;min-width:0;align-items:center}
.vts{position:relative;display:flex;gap:2px;min-width:0;overflow-x:auto;scrollbar-width:none}
.vts::-webkit-scrollbar{display:none}
.dvbar .tools{flex:0 1 auto;min-width:0}
/* an opening search gives way, the view tabs do not */
.dvbar .sfield{flex:0 1 200px;min-width:120px}
.dvbar .btn.dark{margin-left:6px;padding:0 12px 0 9px;gap:5px}
@container main (max-width:600px){
  .dvbar{flex-wrap:wrap}
  .dvbar .tabs{max-width:100%;flex-shrink:1}
  .dvbar .tools{flex:1 1 auto;justify-content:flex-end;flex-wrap:wrap;row-gap:8px}
  /* an open search takes its own full row under the icons */
  .dvbar .sfield{flex:1 1 100%;order:9;width:auto;min-width:0}
}

/* group headers: sentence case, the count right after, the chevron only on hover (or while folded) */
.gh{display:flex;align-items:center;height:28px;margin:12px 0 2px}
.gh:first-child{margin-top:0}
.ghb{display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 9px;border-radius:8px;font:520 12px/20px var(--sans);color:var(--t4);transition:color .12s}
.ghb:hover{color:var(--t0)}
.gn{color:var(--t5);font-weight:430}
.ghb svg{opacity:0;margin-left:-2px;transition:opacity .12s}
.ghb:hover svg,.gh.col .ghb svg{opacity:1}
.gmore{display:flex;align-items:center;height:28px;padding:0 9px 0 39px;margin-top:2px;border-radius:8px;color:var(--t4);font-size:13px;width:100%}
.gmore:hover{background:var(--hov);color:var(--t0)}
.page .gmore{padding-left:12px;margin-top:8px;width:auto}
.page .gh{margin:22px 0 8px}.page .gh:first-child{margin-top:0}
.page .ghb{margin-left:-9px;font-size:13px}

/* one conversation row, the same in both apps: its title (and, nested, how many chats sit inside) */
.cv{position:relative;display:flex;align-items:center;gap:10px;height:32px;padding:0 9px;margin-top:2px;border-radius:8px;cursor:default;transition:background .12s}
.cv:hover{background:var(--hov)}
.cv.d1{padding-left:27px}
.cv.fresh{animation:fresh 1.6s ${EASE}}
.cvm{display:flex;align-items:center;gap:6px;flex:none;color:var(--t5);font-size:12px;line-height:16px}
.cc{min-width:17px;height:17px;padding:0 5px;border-radius:5px;background:rgba(0,0,0,.055);color:var(--t4);font-size:11px;line-height:17px;text-align:center;font-weight:520}
.tm{min-width:22px;text-align:right;font-variant-numeric:tabular-nums}
.cv .md{color:var(--t5)}
.cg{display:grid;grid-template-columns:repeat(auto-fill,minmax(112px,1fr));gap:8px;padding:2px 0}
.ccard{position:relative;border-radius:10px;background:#fff;box-shadow:0 0 0 1px var(--line);transition:box-shadow .15s}
.ccard:hover{box-shadow:0 0 0 1px rgba(0,0,0,.18)}
.ccard .cbtn{display:flex;flex-direction:column;gap:4px;padding:10px 10px 9px;min-height:84px}
.cct{font-size:13px;line-height:18px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.ccard .cm{font-size:12px;margin-top:auto}
.tbl{width:100%;border-collapse:collapse;table-layout:fixed;font-size:13.5px}
.tbl th{font:500 12px/16px var(--sans);color:var(--t4);text-align:left;padding:8px 8px;border-bottom:1px solid var(--line);white-space:nowrap;cursor:pointer;user-select:none}
.tbl th:hover{color:var(--t0)}
.tbl th span{display:inline-flex;align-items:center;gap:3px}
.tbl td{height:38px;padding:0 8px;border-bottom:1px solid var(--line);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--t2)}
.tbl td:first-of-type{color:var(--t0)}
.tbl tr[data-id]:hover td{background:var(--hov)}
.tbl .nm{display:flex;align-items:center;gap:8px;min-width:0}.tbl .nm span{overflow:hidden;text-overflow:ellipsis}
.tbl .nm .ki{width:22px;height:22px;border-radius:6px}
.tbl .gtr td{border-bottom:0;padding:0;height:auto}
.tbl .gtr .gh{margin:18px 0 4px}.tbl .gtr:first-child .gh{margin-top:6px}

/* ---------- feature lines: one per line, the two lists side by side; the dot is its status ---------- */
.fl{margin:14px 0 0;display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);column-gap:24px;row-gap:1px;padding:0 4px;color:var(--fg3,#8a8a90);font-size:12.5px;line-height:18px}
.flh{font-weight:600;font-size:11.5px;letter-spacing:.02em;margin-bottom:4px;opacity:.9}
.fi{display:flex;gap:8px;min-width:0;padding:2px 6px;margin:0 -6px;border-radius:6px;cursor:default;transition:color .15s,background .15s}
.fi i{flex:none;width:6px;height:6px;border-radius:50%;margin-top:6px}
.fi i.ok{background:#4f9a6a}.fi i.part{background:#d6a62a}.fi i.miss{background:#d2563f}.fi i.nu{background:currentColor;opacity:.55}
.fi.lit{color:var(--fg2,#45454a);background:color-mix(in srgb,currentColor 7%,transparent)}
.cap{margin:14px 0 0;text-align:center;font-size:13px;line-height:18px;color:var(--fg3,#8a8a90)}
/* a feature line's highlight: ONE box per surface, drawn over the figure (never on the element, so nothing moves) */
.hbox{position:absolute;pointer-events:none;z-index:40;border:2px solid var(--clay);animation:hint 1.1s ease-in-out infinite}
@keyframes hint{50%{border-color:rgba(217,119,87,.35)}}
@keyframes vin{from{opacity:0;transform:translateY(5px)}}


/* ---------- narrow: the sidebar stacks above the page ---------- */
@container fig (max-width:640px){
  .frame{grid-template-columns:minmax(0,1fr);grid-template-rows:auto auto;height:auto}
  .sb{height:470px;border-right:0;border-bottom:1px solid var(--line);transition:height .28s ${EASE}}
  .frame.col .sb{height:48px}
  .frame.col .word{display:block}
  .frame.col .nav,.frame.col .acct{display:none}
  .main{height:560px}
  .frame.solo{height:auto}
  .page{padding:22px 18px 56px}
  .ag{grid-template-columns:repeat(auto-fill,minmax(126px,1fr));gap:12px}
  .th{height:84px;font-size:6.5px}
  .cf{height:52px;padding:0 10px}.ct{font-size:13px}.cm{font-size:12px}
  .fl{column-gap:16px;font-size:12px;line-height:17px}
  .fi i{margin-top:5.5px}
}
@media (prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;transition:none!important}}

/* ---------- native: the same data view drawn straight on the page, in the page's own theme (Notion's look) ---------- */
:host{--pg-bg:var(--bg,#07090e);--pg-fg:var(--fg,#f4f4f5);--pg-fg2:var(--fg2,#b4b4bd);--pg-fg3:var(--fg3,#71717a);--pg-line:var(--line,rgba(255,255,255,.08));--pg-menu:var(--popover)}
.cl.native{--bg:transparent;--t0:var(--pg-fg);--t2:var(--pg-fg2);--t4:var(--pg-fg3);--t5:color-mix(in srgb,var(--pg-fg3) 75%,transparent);
  --line:var(--pg-line);--line2:color-mix(in srgb,var(--pg-fg) 12%,transparent);--hov:color-mix(in srgb,var(--pg-fg) 6%,transparent);--sel:color-mix(in srgb,var(--pg-fg) 10%,transparent);
  --sans:var(--font-sans);color-scheme:normal}
/* one fixed height whatever the view, so switching views never moves the text below; only the records scroll */
.native .frame.solo{height:340px;background:none;box-shadow:none;border-radius:0;overflow:visible}
.native .main{height:100%}
.native .ms{overflow:visible;height:100%}
.native .page{max-width:none;padding:0;height:100%;display:flex;flex-direction:column}
.native .h1{font:700 20px/28px var(--sans);letter-spacing:-.01em;margin:0 0 6px;flex:none}
.native [data-tb]{flex:none}
.native .bar{margin-bottom:8px}
.nsc{flex:1;min-height:0;overflow-y:auto;overflow-x:hidden;scrollbar-width:thin;scrollbar-color:var(--line2) transparent;
  -webkit-mask-image:linear-gradient(#000 calc(100% - 28px),transparent);mask-image:linear-gradient(#000 calc(100% - 28px),transparent)}
.native .tbl{font-size:13px}
.native .tbl th{position:sticky;top:0;z-index:1;background:var(--pg-bg);padding:6px 8px}
.native .tbl td{height:30px}
.native .tbl .nm .ki{width:20px;height:20px}
.native .ag{grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:12px}
.native .th{height:78px;font-size:7px}
.native .cf{height:46px;padding:0 10px}
.native .ct{font-size:13px}.native .cm{font-size:12px}
.native .arow{height:36px}
.native .arb .ki{width:22px;height:22px}
.native .page .gh{margin:14px 0 4px}.native .page .gh:first-child{margin-top:0}
.native .card{background:color-mix(in srgb,var(--pg-fg) 3%,transparent);border-radius:10px}
.native .card:hover{box-shadow:0 0 0 1px color-mix(in srgb,var(--pg-fg) 22%,transparent)}
.native .cf{background:none}
.native .th{background:color-mix(in srgb,var(--pg-fg) 5%,transparent)!important}
.native .ki{background:color-mix(in srgb,currentColor 20%,transparent)!important}
.native .menu{background:var(--pg-menu);box-shadow:inset 0 0 0 1px var(--line2),0 12px 32px rgba(0,0,0,.4),0 2px 6px rgba(0,0,0,.2)}
.native .mi:hover,.native .mi.hv{background:var(--hov)}
.native .sfield{background:none}
`;

/* ============================== icons ============================== */
const P: Record<string, string> = {
  sidebar:
    '<rect x="3" y="4" width="14" height="12" rx="2.5"/><path d="M7.5 4.5v11"/>',
  /* search, filter, list and plus are traced from claude.ai's own icon font (Anthropicons, 20px, 1.25 stroke) */
  plus: '<path d="M10 3.6v12.8M3.6 10h12.8"/>',
  art: '<rect x="3.5" y="6.5" width="9" height="10" rx="2"/><path d="M7 6.5V5.5a2 2 0 0 1 2-2h5.5a2 2 0 0 1 2 2V11a2 2 0 0 1-2 2h-2"/>',
  chat: '<path d="M10 3.6c3.8 0 6.4 2.6 6.4 5.8s-2.6 5.8-6.4 5.8c-.8 0-1.6-.1-2.3-.3l-3.5 1.6.9-3c-.9-1.1-1.4-2.5-1.4-4.1 0-3.2 2.6-5.8 6.3-5.8Z"/>',
  stack:
    '<path d="M5.5 3.8h9M4.5 6.6h11"/><rect x="3.5" y="9.3" width="13" height="7.2" rx="2"/>',
  search:
    '<circle cx="9.05" cy="9.05" r="5.95"/><path d="m13.3 13.3 3.05 3.05"/>',
  filter:
    '<path d="M5 4h10c.95 0 1.45 1.1.85 1.8l-3.65 4.3c-.25.3-.4.68-.4 1.08V15a1 1 0 0 1-1 1H9.2a1 1 0 0 1-1-1v-3.82c0-.4-.15-.78-.4-1.08L4.15 5.8C3.55 5.1 4.05 4 5 4Z"/>',
  list: '<path d="M8.5 4.55h8.3M8.5 10h8.3M8.5 15.45h8.3"/><path stroke-width="2.1" d="M3.5 4.5h0M3.5 10h0M3.5 15.5h0"/>',
  grid: '<rect x="3.6" y="3.6" width="5.3" height="5.3" rx="1.3"/><rect x="11.1" y="3.6" width="5.3" height="5.3" rx="1.3"/><rect x="3.6" y="11.1" width="5.3" height="5.3" rx="1.3"/><rect x="11.1" y="11.1" width="5.3" height="5.3" rx="1.3"/>',
  table:
    '<rect x="3.6" y="4" width="12.8" height="12" rx="2"/><path d="M3.6 8.2h12.8M3.6 12.1h12.8M8.2 8.2V16"/>',
  sort: '<path d="M6.6 3.8v12.4m0 0-2.9-2.9m2.9 2.9 2.9-2.9M13.4 16.2V3.8m0 0-2.9 2.9m2.9-2.9 2.9 2.9"/>',
  group:
    '<rect x="3.6" y="3.8" width="12.8" height="4.8" rx="1.4"/><rect x="3.6" y="11.4" width="12.8" height="4.8" rx="1.4"/>',
  select:
    '<rect x="3.6" y="3.6" width="12.8" height="12.8" rx="3"/><path d="m7 10.2 2.1 2.1 4-4.5"/>',
  close: '<path d="m5.5 5.5 9 9M14.5 5.5l-9 9"/>',
  chev: '<path d="m6 8 4 4 4-4"/>',
  right: '<path d="m8 5.5 4.5 4.5L8 14.5"/>',
  left: '<path d="M12 5.5 7.5 10l4.5 4.5"/>',
  check: '<path d="m4.5 10.5 3.5 3.5 7.5-8.5"/>',
  more: '<circle cx="5" cy="10" r=".9"/><circle cx="10" cy="10" r=".9"/><circle cx="15" cy="10" r=".9"/>',
  pin: '<path d="M7.5 3.5h5l-.6 4.2 2.6 2.8v1.2h-9v-1.2l2.6-2.8-.6-4.2ZM10 11.7v4.8"/>',
  pencil:
    '<path d="M12.8 4.2a1.9 1.9 0 0 1 2.7 2.7l-8.6 8.6-3.4.8.8-3.4 8.5-8.7Z"/>',
  dup: '<rect x="7" y="7" width="9.5" height="9.5" rx="2"/><path d="M13 7V5.5a2 2 0 0 0-2-2H5.5a2 2 0 0 0-2 2V11a2 2 0 0 0 2 2H7"/>',
  link: '<path d="M8.6 11.4a3 3 0 0 0 4.2 0l2.5-2.5a3 3 0 0 0-4.2-4.2l-.8.8M11.4 8.6a3 3 0 0 0-4.2 0l-2.5 2.5a3 3 0 0 0 4.2 4.2l.8-.8"/>',
  users:
    '<circle cx="8" cy="7" r="2.8"/><path d="M3 16c.4-2.6 2.5-4.2 5-4.2s4.6 1.6 5 4.2M13 4.4a2.7 2.7 0 0 1 0 5.2M14.8 12c1.3.6 2 1.9 2.2 4"/>',
  move: '<path d="M4 15.5V12a3.5 3.5 0 0 1 3.5-3.5H16m0 0-3.5-3.5M16 8.5 12.5 12"/>',
  trash:
    '<path d="M4 6h12M8 6V4.5h4V6M5.6 6l.8 9.6a1.5 1.5 0 0 0 1.5 1.4h4.2a1.5 1.5 0 0 0 1.5-1.4L14.4 6M8.5 9v5M11.5 9v5"/>',
  archive:
    '<rect x="3" y="4" width="14" height="4" rx="1.2"/><path d="M4.5 8v6.5A1.5 1.5 0 0 0 6 16h8a1.5 1.5 0 0 0 1.5-1.5V8M8.5 11h3"/>',
  up: '<path d="M10 15.5v-11m0 0L6 8.5m4-4 4 4"/>',
  down: '<path d="M10 4.5v11m0 0-4-4m4 4 4-4"/>',
  globe:
    '<circle cx="10" cy="10" r="6.5"/><path d="M3.5 10h13M10 3.5c1.7 1.8 2.5 4 2.5 6.5s-.8 4.7-2.5 6.5c-1.7-1.8-2.5-4-2.5-6.5s.8-4.7 2.5-6.5Z"/>',
  building:
    '<path d="M4.5 16.5v-12h7v12M11.5 8.5h4v8M3 16.5h14M7 7.5h2M7 10.5h2M7 13.5h2"/>',
  doc: '<path d="M5.5 3.5h6l3 3v10h-9v-13Z"/><path d="M11.5 3.5v3h3M8 10.5h4.5M8 13h3"/>',
  slides:
    '<rect x="3" y="4" width="14" height="9.5" rx="1.5"/><path d="M10 13.5v3M7.5 16.5h5"/>',
  sheet:
    '<rect x="3.5" y="3.5" width="13" height="13" rx="2"/><path d="M3.5 8h13M3.5 12.3h13M8 8v8.5"/>',
  palette:
    '<path d="M10 3.5a6.5 6.5 0 1 0 0 13c1 0 1.4-.8 1-1.6-.5-1 .1-2 1.2-2h1.6a2.7 2.7 0 0 0 2.7-2.7c0-3.8-2.9-6.7-6.5-6.7Z"/><circle cx="6.8" cy="9.5" r=".8"/><circle cx="9" cy="6.6" r=".8"/><circle cx="12.4" cy="7.2" r=".8"/>',
  chart:
    '<rect x="4" y="10" width="3" height="6.5" rx="1"/><rect x="8.5" y="4" width="3" height="12.5" rx="1"/><rect x="13" y="7.5" width="3" height="9" rx="1"/>',
  shapes:
    '<circle cx="7.5" cy="7.5" r="4"/><rect x="9" y="9" width="7.5" height="7.5" rx="1.6"/>',
  app: '<rect x="3.5" y="3.5" width="13" height="13" rx="3"/><path d="M3.5 7.5h13"/>',
  folder:
    '<path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h3.2l1.6 1.8h6.2A1.5 1.5 0 0 1 17 8.3v6.2a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 3 14.5v-8Z"/>',
  send: '<path d="M10 15.5v-11M5.5 9 10 4.5 14.5 9"/>',
  /* the data view's own glyphs, drawn on the same 20px grid and 1.25 stroke */
  sliders:
    '<path d="M3.5 6h2.3M9.2 6h7.3M3.5 14h7.3M14.2 14h2.3"/><circle cx="7.5" cy="6" r="1.7"/><circle cx="12.5" cy="14" r="1.7"/>',
  listnum:
    '<path d="M9 5.2h7.5M9 10h7.5M9 14.8h7.5"/><path d="M3.9 3.6h1v3.5M3.6 7.1h1.9M3.6 11.4c.1-.8 1.9-.9 1.9.2 0 .8-1.9 1.4-1.9 2.4h2"/>',
  brain:
    '<path d="M10 4.6v11M10 5.2a2.5 2.5 0 0 0-4.5 1.2 2.6 2.6 0 0 0-1.3 4.2 2.6 2.6 0 0 0 1.7 3.8 2.4 2.4 0 0 0 4.1 1.2M10 5.2a2.5 2.5 0 0 1 4.5 1.2 2.6 2.6 0 0 1 1.3 4.2 2.6 2.6 0 0 1-1.7 3.8 2.4 2.4 0 0 1-4.1 1.2"/>',
  history:
    '<path d="M4.2 10a5.8 5.8 0 1 0 1.8-4.2L4.2 7.5"/><path d="M4.2 4.4v3.1h3.1M10 7v3.2l2.2 1.5"/>',
  user: '<circle cx="10" cy="7" r="3"/><path d="M4.6 16.4c.6-2.9 2.8-4.5 5.4-4.5s4.8 1.6 5.4 4.5"/>',
  gear: '<circle cx="10" cy="10" r="2.3"/><path d="M10 3.4l1.2 1.7 2-.5.5 2 1.8 1-.8 1.9.8 1.9-1.8 1-.5 2-2-.5L10 16.6l-1.2-1.7-2 .5-.5-2-1.8-1 .8-1.9-.8-1.9 1.8-1 .5-2 2 .5L10 3.4Z"/>',
  layers:
    '<path d="m10 3.8 6.4 3.3L10 10.4 3.6 7.1 10 3.8Z"/><path d="m3.6 10.4 6.4 3.3 6.4-3.3M3.6 13.6l6.4 3.3 6.4-3.3"/>',
  nest: '<path d="M5 4v8.6A1.4 1.4 0 0 0 6.4 14H9M5 7.8h4"/><rect x="10.5" y="5.8" width="6" height="4" rx="1.2"/><rect x="10.5" y="12" width="6" height="4" rx="1.2"/>',
};
const FILLED: Record<string, 1> = { more: 1 };
export const ic = (n: string, s = 20) =>
  `<svg width="${s}" height="${s}" viewBox="0 0 20 20" fill="${FILLED[n] ? "currentColor" : "none"}" stroke="currentColor" stroke-width="${FILLED[n] ? 0 : 1.25}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[n]}</svg>`;
export const esc = (s: unknown) =>
  String(s).replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!,
  );
export const hash = (s: string) => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++)
    h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
};
