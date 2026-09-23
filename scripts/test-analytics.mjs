import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

// Exercise the shipped browser module without sending test traffic to Google.
const source = ts.transpileModule(readFileSync('src/scripts/analytics.ts', 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText.replace(/export\s*\{\s*\};?/, '');
const key = 'nutcx-analytics-consent-v1';
const disabledKey = 'ga-disable-G-LZFHMGC1GT';
function browser({ saved, host = 'nutcx.github.io', enabled = true, storageFails = false } = {}) {
  class Element {
    listeners = {}; hidden = true; dataset = {}; textContent = ''; focused = false;
    addEventListener(name, handler) { this.listeners[name] = handler; }
    focus() { this.focused = true; }
    click() { this.listeners.click?.({target:this}); }
    closest() { return this; }
  }
  const nodes = Object.fromEntries(['panel','status','close','accept','decline','settings'].map(name=>[name,new Element()]));
  nodes.panel.dataset.analyticsEnabled = String(enabled);
  const scripts = [], cookieWrites = [], documentListeners = {}, windowListeners = {};
  const savedValues = new Map(saved ? [[key,saved]] : []);
  const document = {
    title: 'Public preview', referrer: 'https://example.org/private-path?secret=hidden',
    head: { append: script => scripts.push(script) },
    createElement: () => ({}),
    querySelector: selector => nodes[selector.match(/data-analytics-(.*)\]/)?.[1]],
    querySelectorAll: () => [nodes.settings],
    addEventListener: (name,handler) => documentListeners[name] = handler,
    get cookie() { return '_ga=test; _ga_LZFHMGC1GT=test; unrelated=keep'; },
    set cookie(value) { cookieWrites.push(value); },
  };
  const window = { addEventListener:(name,handler)=>windowListeners[name]=handler };
  const context = {document,window,Element,URL,Date,location:{hostname:host,protocol:'https:',origin:`https://${host}`,pathname:'/heroes/1/1011/',search:'?secret=hidden',hash:'#secret'},localStorage:{getItem:k=>{if(storageFails)throw Error();return savedValues.get(k);},setItem:(k,v)=>{if(storageFails)throw Error();savedValues.set(k,v);}}};
  vm.runInNewContext(source, context);
  const entries = () => (window.dataLayer || []).map(args=>Array.from(args));
  return { nodes,scripts,cookieWrites,window,savedValues,entries,
    clickLink(href,placement='item-preview') { const link = new Element();link.href=href;link.dataset.playPlacement=placement;documentListeners.click({target:link}); },
    storage(value) { windowListeners.storage({key,newValue:value}); },
  };
}

const initial = browser();
assert.equal(initial.scripts.length,0,'No Google script before consent');
assert.equal(initial.nodes.panel.hidden,false);
initial.clickLink('https://play.google.com/store/apps/details?id=com.nutcx.tools');
assert.equal(initial.entries().length,0,'No measurement before consent');
initial.nodes.decline.click();
assert.equal(initial.scripts.length,0,'Declining never loads a tag');
assert.equal(initial.savedValues.get(key),'denied');
assert.equal(browser({saved:'denied'}).nodes.panel.hidden,true);

const accepted = browser();
accepted.nodes.accept.click();
assert.equal(accepted.scripts.length,1);
assert.equal(accepted.scripts[0].referrerPolicy,'origin');
assert.equal(accepted.entries().filter(entry=>entry[1]==='page_view').length,1);
const config = accepted.entries().find(entry=>entry[0]==='config')[2];
assert.equal(config.page_location,'https://nutcx.github.io/heroes/1/1011/');
assert.equal(config.page_referrer,'https://example.org');
assert.equal(config.send_page_view,false);
assert.equal(config.allow_google_signals,false);
assert.equal(config.allow_ad_personalization_signals,false);
assert.ok(!JSON.stringify(accepted.entries()).includes('secret'));
accepted.clickLink('https://play.google.com/store/apps/details?id=com.nutcx.tools');
accepted.clickLink('https://play.google.com/store/apps/details?id=another.app');
accepted.clickLink('https://play.google.com.evil.example/store/apps/details?id=com.nutcx.tools');
accepted.clickLink('intent://nutcx.github.io/heroes/1/#Intent;end');
assert.equal(accepted.entries().filter(entry=>entry[1]==='play_store_click').length,1,'Only direct NutCracker Play clicks count');
accepted.nodes.decline.click();
assert.equal(accepted.window[disabledKey],true);
assert.equal(accepted.cookieWrites.length,2);
assert.ok(accepted.cookieWrites.every(cookie=>!cookie.startsWith('unrelated')));
accepted.clickLink('https://play.google.com/store/apps/details?id=com.nutcx.tools');
assert.equal(accepted.entries().filter(entry=>entry[1]==='play_store_click').length,1,'Withdrawal stops clicks');
accepted.nodes.accept.click();
assert.equal(accepted.window[disabledKey],false,'Consent can be granted again');
assert.equal(accepted.scripts.length,1,'Consent changes do not load duplicate tags');
accepted.clickLink('https://play.google.com/store/apps/details?id=com.nutcx.tools');
assert.equal(accepted.entries().filter(entry=>entry[1]==='play_store_click').length,2);
accepted.storage('denied');
assert.equal(accepted.window[disabledKey],true,'Other-tab withdrawal disables measurement');
accepted.storage('granted');
assert.equal(accepted.window[disabledKey],false);
assert.equal(browser({saved:'granted'}).scripts.length,1);
assert.equal(browser({saved:'granted',host:'localhost'}).scripts.length,0,'Local previews do not send analytics');
assert.equal(browser({saved:'granted',enabled:false}).scripts.length,0,'Excluded pages do not send analytics');
const storageBlocked = browser({storageFails:true});
assert.equal(storageBlocked.scripts.length,0);
storageBlocked.nodes.accept.click();
assert.equal(storageBlocked.scripts.length,1,'Explicit session-only consent works without storage');
console.log('Analytics checks passed: consent, withdrawal/regrant, cross-tab choice, URL minimization, click attribution, and development exclusion.');
