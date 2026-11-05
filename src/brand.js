// Branding comes from the /brand folder (bundled at build time, so it works on Cloudflare Workers too):
//   brand/brand.json  name, logo files, default business name, optional theme stylesheet
//   brand/demo.json   sample reviews for demo mode
//   brand/*.png|svg|ico|webp|woff2|css   public assets, served at /brand/...
import brandJson from '../brand/brand.json' with { type: 'json' };
import demoJson from '../brand/demo.json' with { type: 'json' };
import { template } from './runtime.js';

const DEFAULTS = {
  name: 'Review Replies',
  appName: 'Review Replies',
  businessName: '',
  website: '',
  logo: null,
  logoDark: null,
  favicon: null,
  appleTouchIcon: null,
  theme: null,
};

export const brand = Object.freeze({ ...DEFAULTS, ...brandJson });
export const brandDemo = demoJson;
export const brandTitle = brand.name === brand.appName ? brand.appName : `${brand.name} ${brand.appName}`;

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const asset = (file) => `/brand/${encodeURIComponent(file)}`;

const DEFAULT_MARK = '<div class="brand-mark"><svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linejoin="round" aria-hidden="true"><path d="M4 5h16v11H11l-4 3v-3H4z"/><path d="m12 7.6.9 1.9 2 .3-1.5 1.4.4 2-1.8-1-1.8 1 .4-2-1.5-1.4 2-.3z" fill="#fff" stroke="none"/></svg></div>';

function logoHtml() {
  if (!brand.logo) return `<div class="brand">${DEFAULT_MARK}<span class="brand-name">${esc(brand.appName)}</span></div>`;
  const dark = brand.logoDark ? `<source srcset="${asset(brand.logoDark)}" media="(prefers-color-scheme: dark)">` : '';
  const sub = brand.appName && brand.appName !== brand.name ? `<span class="brand-sub">${esc(brand.appName)}</span>` : '';
  return `<div class="brand brand-custom"><picture>${dark}<img class="brand-logo" src="${asset(brand.logo)}" alt="${esc(brand.name)}"></picture>${sub}</div>`;
}

function headHtml() {
  const icon = brand.favicon ? `<link rel="icon" href="${asset(brand.favicon)}">` : '<link rel="icon" href="/assets/favicon.svg" type="image/svg+xml">';
  const touch = brand.appleTouchIcon ? `<link rel="apple-touch-icon" href="${asset(brand.appleTouchIcon)}">` : '';
  const theme = brand.theme ? `<link rel="stylesheet" href="${asset(brand.theme)}">` : '';
  return `${icon}${touch}<link rel="stylesheet" href="/assets/app.css">${theme}`;
}

const cache = new Map();

/** Fill the {{...}} placeholders of an HTML page ('login' or 'app') with this deployment's branding. */
export function renderPage(name) {
  if (cache.has(name)) return cache.get(name);
  const html = template(name)
    .replaceAll('{{HEAD}}', headHtml())
    .replaceAll('{{LOGO}}', logoHtml())
    .replaceAll('{{TITLE}}', esc(brandTitle))
    .replaceAll('{{BRAND_NAME}}', esc(brand.name))
    .replaceAll('{{APP_NAME}}', esc(brand.appName))
    .replaceAll('{{BUSINESS_NAME}}', esc(brand.businessName || brandDemo?.businessName || brand.name));
  cache.set(name, html);
  return html;
}

/** Files in /brand that browsers may fetch (never the JSON config). */
export const SERVABLE_BRAND_FILE = /^[\w.-]+\.(png|svg|webp|ico|jpe?g|css|woff2?)$/i;
