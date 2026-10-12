/**
 * Bundle natif d'icônes « Material » pour l'explorateur.
 *
 * Objectif : offrir, **sans aucune extension installée**, des icônes de fichiers
 * et dossiers fidèles au Material Icon Theme officiel (comportement par défaut de
 * VS Code avec l'extension préinstallée).
 *
 * Conception :
 *  - un **catalogue de glyphes SVG officiels** (issus du Material Icon Theme,
 *    https://github.com/PKief/vscode-material-icon-theme) — chaque glyphe porte
 *    **sa propre couleur** (`fill="#…"`), comme les icônes réelles ;
 *  - un **mapping déclaratif** nom de fichier exact → clé, extension → clé, et
 *    un mapping **langage** → clé alimenté par le registre `lib/languages.ts` ;
 *  - un `resolveMaterialIcon(name, isDir, expanded, languageIcon)` qui renvoie une
 *    data-URI `image/svg+xml` prête pour un `<img>`.
 *
 * Sécurité : ce module est purement déclaratif (données statiques, aucun code
 * exécuté, aucune entrée utilisateur interprétée). Les SVG sont **générés ici**
 * (jamais lus depuis le disque), donc jamais issus d'une source non fiable.
 */

// ── Glyphes officiels (SVG Material Icon Theme) ──────────────────────────────
// Chaque entrée est un SVG complet et autonome (viewBox + couleurs intégrées).
// Le repli générique `file` reprend un document neutre quand aucune clé ne matche.

const GLYPH_FILE =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">' +
  '<path fill="#90a4ae" d="M13 9h5.5L13 3.5zM6 2h8l6 6v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2"/></svg>';

const GLYPH_FOLDER =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">' +
  '<path fill="#90a4ae" d="M10 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-8z"/></svg>';

/**
 * Catalogue des icônes officielles, indexé par clé sémantique.
 * Chaque valeur est un SVG autonome (contient son propre `fill`).
 */
const ICONS: Record<string, string> = {
  // ── Web / data ────────────────────────────────────────────────────────────
  typescript:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><path fill="#0288d1" d="M4 4h24v24H4z"/><path fill="#fff" d="M13.7 16.2h-3V26H8.4V16.2h-3v-2.4h8.3zm1.4 9.6v-2.5c.4.3.9.5 1.5.7s1.2.3 1.8.3c.4 0 .7-.05.97-.1.3-.06.5-.15.7-.27s.4-.28.5-.47.1-.43.1-.7-.07-.6-.2-.8-.3-.4-.56-.6-.55-.4-.9-.6-.72-.4-1.1-.6c-1-.5-1.7-1-2.2-1.6s-.7-1.4-.7-2.3c0-.7.14-1.3.42-1.9s.66-1 1.15-1.4.9-.6 1.5-.8 1.2-.28 2-.28c.7 0 1.3.05 1.9.15s1 .25 1.5.45v2.4c-.3-.2-.6-.35-.95-.5s-.7-.25-1-.3-.7-.1-1-.1-.7.04-1 .12-.5.2-.7.35-.3.34-.4.55-.14.46-.14.73c0 .4.1.74.3 1s.4.47.7.68.63.4 1 .6.75.4 1.1.6c.5.3.9.6 1.3.9s.7.65.9 1 .4.8.5 1.3.15 1 .15 1.6c0 .7-.14 1.3-.4 1.9s-.6 1-1.1 1.4-.95.7-1.5.9-1.25.3-2 .3c-.75 0-1.5-.1-2.2-.25s-1.3-.4-1.8-.7"/></svg>',
  react_ts:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><circle cx="16" cy="15.974" r="2.5" fill="#00bcd4"/><path fill="#00bcd4" d="M16 21.706a28.4 28.4 0 0 1-8.88-1.2 11.3 11.3 0 0 1-3.657-1.958A3.54 3.54 0 0 1 2 15.974c0-1.653 1.816-3.273 4.858-4.333A28.8 28.8 0 0 1 16 10.293a28.7 28.7 0 0 1 9.022 1.324 11.3 11.3 0 0 1 3.538 1.866C30.188 14.578 30 15.313 30 15.974c0 1.653-1.816 3.273-4.858 4.333a28.8 28.8 0 0 1-9.022 1.324zm0-10.293a26.7 26.7 0 0 0-8.523 1.252A9.8 9.8 0 0 0 4.067 14.39a1.5 1.5 0 0 0-.45.586 6 6 0 0 0 2.714.825 26.6 26.6 0 0 0 8.709.977 26.6 26.6 0 0 0 8.526-1.024 5.8 5.8 0 0 0 2.642-.776 6 6 0 0 0-2.692-.78 26.6 26.6 0 0 0-8.516-.92z"/><path fill="#00bcd4" d="M10.732 29.616a3.6 3.6 0 0 1-1.857-.567 3.5 3.5 0 0 1-1.34-1.428 3.2 3.2 0 0 1-.282-1.865c.168-1.36 1.484-3.009 3.274-4.062a28.6 28.6 0 0 1 7.83-2.981 28.9 28.9 0 0 1 8.397-.86c2.06.052 3.65.3 4.66.86a3.5 3.5 0 0 1 1.34 1.428 3.2 3.2 0 0 1 .283 1.865c-.168 1.36-1.484 3.009-3.274 4.062a28.6 28.6 0 0 1-7.83 2.981 28.9 28.9 0 0 1-8.4.86 12 12 0 0 1-2.813-.365zm2.502-5.15c-1.35.864-2.43 1.9-3.055 2.913a1.7 1.7 0 0 0-.35.87 1.5 1.5 0 0 0 .217.9 5.6 5.6 0 0 0 2.792.227 26.8 26.8 0 0 0 8.023-1.33 5.5 5.5 0 0 0 2.615-1.434 5.6 5.6 0 0 0-2.5-.474 26.8 26.8 0 0 0-7.77-.1z"/><path fill="#00bcd4" d="M21.268 29.616a12 12 0 0 1-2.813-.365 28.6 28.6 0 0 1-7.83-2.981c-1.79-1.053-3.106-2.702-3.274-4.062a3.2 3.2 0 0 1 .283-1.865 3.5 3.5 0 0 1 1.34-1.428c1.01-.56 2.6-.808 4.66-.86a28.9 28.9 0 0 1 8.397.86 28.6 28.6 0 0 1 7.83 2.981c1.79 1.053 3.106 2.702 3.274 4.062a3.2 3.2 0 0 1-.282 1.865 3.5 3.5 0 0 1-1.34 1.428 3.6 3.6 0 0 1-1.857.567zm-9.767-4.162a5.6 5.6 0 0 0 2.615 1.434 26.8 26.8 0 0 0 8.023 1.33 5.6 5.6 0 0 0 2.792-.227 1.5 1.5 0 0 0 .217-.9 1.7 1.7 0 0 0-.35-.87c-.625-1.013-1.705-2.05-3.055-2.913a26.8 26.8 0 0 0-7.77.1 5.6 5.6 0 0 0-2.5.474z"/></svg>',
  javascript:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><path fill="#ffca28" d="M4 4h24v24H4z"/><path fill="#263238" d="M8.5 24H6.2l1.6-2.4h2.4zm3.5.2c-1 0-1.8-.2-2.4-.6s-1-1-1.2-1.8l2.1-.9c.1.4.3.7.5.9s.5.3.9.3.7-.1.9-.3.3-.4.3-.7-.1-.6-.4-.8-.7-.4-1.3-.6c-1-.3-1.7-.7-2.2-1.2s-.7-1.2-.7-2.1c0-.5.1-1 .3-1.4s.5-.8.9-1.1.8-.5 1.3-.7 1-.2 1.6-.2c.9 0 1.7.2 2.3.6s1 1 1.2 1.7l-2.1.9c-.1-.3-.3-.6-.5-.7s-.5-.2-.8-.2-.6.1-.8.2-.3.3-.3.6.1.5.4.7.7.4 1.3.6c1 .3 1.7.7 2.2 1.2s.7 1.2.7 2.1c0 .5-.1 1-.3 1.4s-.5.8-.9 1.1-.8.5-1.4.7-1.1.2-1.7.2z"/></svg>',
  react:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><circle cx="16" cy="15.974" r="2.5" fill="#00bcd4"/><path fill="#00bcd4" d="M16 21.706a28.4 28.4 0 0 1-8.88-1.2 11.3 11.3 0 0 1-3.657-1.958A3.54 3.54 0 0 1 2 15.974c0-1.653 1.816-3.273 4.858-4.333A28.8 28.8 0 0 1 16 10.293a28.7 28.7 0 0 1 9.022 1.324 11.3 11.3 0 0 1 3.538 1.866C30.188 14.578 30 15.313 30 15.974c0 1.653-1.816 3.273-4.858 4.333a28.8 28.8 0 0 1-9.022 1.324zm0-10.293a26.7 26.7 0 0 0-8.523 1.252A9.8 9.8 0 0 0 4.067 14.39a1.5 1.5 0 0 0-.45.586 6 6 0 0 0 2.714.825 26.6 26.6 0 0 0 8.709.977 26.6 26.6 0 0 0 8.526-1.024 5.8 5.8 0 0 0 2.642-.776 6 6 0 0 0-2.692-.78 26.6 26.6 0 0 0-8.516-.92z"/><path fill="#00bcd4" d="M10.732 29.616a3.6 3.6 0 0 1-1.857-.567 3.5 3.5 0 0 1-1.34-1.428 3.2 3.2 0 0 1-.282-1.865c.168-1.36 1.484-3.009 3.274-4.062a28.6 28.6 0 0 1 7.83-2.981 28.9 28.9 0 0 1 8.397-.86c2.06.052 3.65.3 4.66.86a3.5 3.5 0 0 1 1.34 1.428 3.2 3.2 0 0 1 .283 1.865c-.168 1.36-1.484 3.009-3.274 4.062a28.6 28.6 0 0 1-7.83 2.981 28.9 28.9 0 0 1-8.4.86 12 12 0 0 1-2.813-.365zm2.502-5.15c-1.35.864-2.43 1.9-3.055 2.913a1.7 1.7 0 0 0-.35.87 1.5 1.5 0 0 0 .217.9 5.6 5.6 0 0 0 2.792.227 26.8 26.8 0 0 0 8.023-1.33 5.5 5.5 0 0 0 2.615-1.434 5.6 5.6 0 0 0-2.5-.474 26.8 26.8 0 0 0-7.77-.1z"/><path fill="#00bcd4" d="M21.268 29.616a12 12 0 0 1-2.813-.365 28.6 28.6 0 0 1-7.83-2.981c-1.79-1.053-3.106-2.702-3.274-4.062a3.2 3.2 0 0 1 .283-1.865 3.5 3.5 0 0 1 1.34-1.428c1.01-.56 2.6-.808 4.66-.86a28.9 28.9 0 0 1 8.397.86 28.6 28.6 0 0 1 7.83 2.981c1.79 1.053 3.106 2.702 3.274 4.062a3.2 3.2 0 0 1-.282 1.865 3.5 3.5 0 0 1-1.34 1.428 3.6 3.6 0 0 1-1.857.567zm-9.767-4.162a5.6 5.6 0 0 0 2.615 1.434 26.8 26.8 0 0 0 8.023 1.33 5.6 5.6 0 0 0 2.792-.227 1.5 1.5 0 0 0 .217-.9 1.7 1.7 0 0 0-.35-.87c-.625-1.013-1.705-2.05-3.055-2.913a26.8 26.8 0 0 0-7.77.1 5.6 5.6 0 0 0-2.5.474z"/></svg>',
  css:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><path fill="#42a5f5" d="m5 4 2 22 9 3 9-3 2-22zm19.72 7H11.28l.29 3h11.86l-.802 9.335L15.99 25l-6.635-1.646L8.93 19h3.02l.19 2 3.86.77 3.84-.77.29-4H8.84L8 8h16z"/></svg>',
  sass:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><path fill="#f55385" d="M14.5 3.5c-3.2.1-6 1.2-7.2 2.7-.7.9-.8 1.8-.4 2.5.6 1.1 2.2 1.8 2.2 3.6 0 1.7-1.4 3.5-4.2 5.9l-.9.7c.2 1 1.9 5.4 7.4 5.4 4.5 0 8.6-3.2 8.6-7.6 0-3.7-2.9-5.4-5.2-5.4-2.6 0-4.6 1.6-4.6 3.6 0 2 1.5 3 2.8 3 1.2 0 1.9-.7 2-.5.1.1-.1.5-.6.8-.6.4-1.5.6-2.5.4-1.9-.3-3.2-1.7-3.2-3.7 0-2.6 2.4-4.9 6.1-4.9 3.9 0 6.9 2.3 6.9 6 0 5.3-4.8 9.2-10.4 9.2-5.8 0-8.3-3.6-8.3-6.1 0-.4 0-.7.1-1 .1.4.2.7.4 1 .5 1.1 1.7 1.8 3 1.5 1.4-.3 1.6-1.5 1.6-2.4 0-1.4-1.2-2-1.2-3.5 0-1.6 1.7-3.1 4.5-3.1 3.3 0 5.4 1.9 5.4 4.6 0 1.4-.6 2.6-1.5 3.5.3-.6.5-1.3.5-2 0-1.9-1.2-3.3-3.2-3.3-1.9 0-3.3 1.3-3.3 3 0 1.6 1.2 2.4 2.5 2.4 1.7 0 3.4-1.4 3.4-4.5 0-3.3-2.8-5.7-6.9-5.7-4.6 0-7.9 2.9-7.9 6.2 0 3.3 2.6 5.4 6.4 5.4 1.6 0 2.9-.4 3.5-.7-1 .9-2.6 1.5-4.4 1.5-2.9 0-4.9-1.6-4.9-3.9 0-2.4 2.1-4.2 5-4.2 2.7 0 4.4 1.3 4.4 3.2 0 1.6-1.2 2.8-2.9 2.8-1.3 0-2.2-.8-2.2-1.9 0-1 .8-1.8 1.9-1.8 1.4 0 2.3 1 2.3 2.5 0 2-1.6 3.5-3.8 3.5-2.9 0-4.8-1.9-4.8-4.6 0-.4 0-.8.1-1.2z"/></svg>',
  html:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><path fill="#e65100" d="m4 4 2 22 10 2 10-2 2-22zm19.72 7H11.28l.29 3h11.86l-.802 9.335L15.99 25l-6.635-1.646L8.93 19h3.02l.19 2 3.86.77 3.84-.77.29-4H8.84L8 8h16z"/></svg>',
  json:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 -960 960 960"><path fill="#f9a825" d="M560-160v-80h120q17 0 28.5-11.5T720-280v-80q0-38 22-69t58-44v-14q-36-13-58-44t-22-69v-80q0-17-11.5-28.5T680-720H560v-80h120q50 0 85 35t35 85v80q0 17 11.5 28.5T840-560h40v160h-40q-17 0-28.5 11.5T800-360v80q0 50-35 85t-85 35zm-280 0q-50 0-85-35t-35-85v-80q0-17-11.5-28.5T120-400H80v-160h40q17 0 28.5-11.5T160-600v-80q0-50 35-85t85-35h120v80H280q-17 0-28.5 11.5T240-680v80q0 38-22 69t-58 44v14q36 13 58 44t22 69v80q0 17 11.5 28.5T280-240h120v80z"/></svg>',
  markdown:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><path fill="#42a5f5" d="m14 10-4 3.5L6 10H4v12h4v-6l2 2 2-2v6h4V10zm12 6v-6h-4v6h-4l6 8 6-8z"/></svg>',
  xml:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="#8bc34a" d="M13 9h5.5L13 3.5zM6 2h8l6 6v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4c0-1.11.89-2 2-2m.12 13.5 3.74 3.74 1.42-1.41-2.33-2.33 2.33-2.33-1.42-1.41zm11.16 0-3.74-3.74-1.42 1.41 2.33 2.33-2.33 2.33 1.42 1.41z"/></svg>',

  // ── Langages ──────────────────────────────────────────────────────────────
  rust:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><path fill="#ff7043" d="m30 12-4-2V6h-4l-2-4-4 2-4-2-2 4H6v4l-4 2 2 4-2 4 4 2v4h4l2 4 4-2 4 2 2-4h4v-4l4-2-2-4ZM6 16a9.9 9.9 0 0 1 .842-4H10v8H6.842A9.9 9.9 0 0 1 6 16m10 10a9.98 9.98 0 0 1-7.978-4H16v-2h-2v-2h4c.819.819.297 2.308 1.179 3.37a1.89 1.89 0 0 0 1.46.63h3.34A9.98 9.98 0 0 1 16 26m-2-12v-2h4a1 1 0 0 1 0 2Zm11.158 6H24a2.006 2.006 0 0 1-2-2 2 2 0 0 0-2-2 3 3 0 0 0 3-3q0-.08-.004-.161A3.115 3.115 0 0 0 19.83 10H8.022a9.986 9.986 0 0 1 17.136 10"/></svg>',
  python:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="#0288d1" d="M9.86 2A2.86 2.86 0 0 0 7 4.86v1.68h4.29c.39 0 .71.57.71.96H4.86A2.86 2.86 0 0 0 2 10.36v3.781a2.86 2.86 0 0 0 2.86 2.86h1.18v-2.68a2.85 2.85 0 0 1 2.85-2.86h5.25c1.58 0 2.86-1.271 2.86-2.851V4.86A2.86 2.86 0 0 0 14.14 2zm-.72 1.61c.4 0 .72.12.72.71s-.32.891-.72.891c-.39 0-.71-.3-.71-.89s.32-.711.71-.711"/><path fill="#fdd835" d="M17.959 7v2.68a2.85 2.85 0 0 1-2.85 2.859H9.86A2.85 2.85 0 0 0 7 15.389v3.75a2.86 2.86 0 0 0 2.86 2.86h4.28A2.86 2.86 0 0 0 17 19.14v-1.68h-4.291c-.39 0-.709-.57-.709-.96h7.14A2.86 2.86 0 0 0 22 13.64V9.86A2.86 2.86 0 0 0 19.14 7zM8.32 11.513l-.004.004.038-.004zm6.54 7.276c.39 0 .71.3.71.89a.71.71 0 0 1-.71.71c-.4 0-.72-.12-.72-.71s.32-.89.72-.89"/></svg>',
  go:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><path fill="#00acc1" d="M2 12h4v2H2zm-2 4h6v2H0zm4 4h2v2H4z"/><path fill="#00acc1" d="M19.063 15H14v3h3.239a4.42 4.42 0 0 1-3.531 2 2.65 2.65 0 0 1-2.053-.858 2.86 2.86 0 0 1-.628-2.28A4.515 4.515 0 0 1 15.292 13a2.73 2.73 0 0 1 1.749.584l2.962-1.185A5.6 5.6 0 0 0 15.292 10a7.526 7.526 0 0 0-7.243 6.5 5.614 5.614 0 0 0 5.659 6.5 7.526 7.526 0 0 0 7.243-6.5 6.4 6.4 0 0 0 .112-1.5m7.229-1.5a7.526 7.526 0 0 0-7.243 6.5 5.614 5.614 0 0 0 5.659 6.5 7.526 7.526 0 0 0 7.243-6.5 5.614 5.614 0 0 0-5.659-6.5m2.681 6.137A4.515 4.515 0 0 1 24.708 20a2.65 2.65 0 0 1-2.053-.858 2.86 2.86 0 0 1-.628-2.28A4.515 4.515 0 0 1 26.292 13a2.65 2.65 0 0 1 2.053.858 2.86 2.86 0 0 1 .628 2.28Z"/></svg>',
  c:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><path fill="#0288d1" d="M19.563 22A5.57 5.57 0 0 1 14 16.437v-2.873A5.57 5.57 0 0 1 19.563 8H24V2h-4.437A11.563 11.563 0 0 0 8 13.563v2.873A11.564 11.564 0 0 0 19.563 28H24v-6Z"/></svg>',
  cpp:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><path fill="#0288d1" d="M28 14v-4h-2v4h-6v-4h-2v4h-4v2h4v4h2v-4h6v4h2v-4h4v-2z"/><path fill="#0288d1" d="M13.563 22A5.57 5.57 0 0 1 8 16.437v-2.873A5.57 5.57 0 0 1 13.563 8H18V2h-4.437A11.563 11.563 0 0 0 2 13.563v2.873A11.564 11.564 0 0 0 13.563 28H18v-6Z"/></svg>',
  java:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><path fill="#f44336" d="M4 26h24v2H4zM28 4H7a1 1 0 0 0-1 1v13a4 4 0 0 0 4 4h10a4 4 0 0 0 4-4v-4h4a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2m0 8h-4V6h4Z"/></svg>',
  csharp:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><path fill="#0288d1" d="M30 14v-2h-2V8h-2v4h-2V8h-2v4h-2v2h2v2h-2v2h2v4h2v-4h2v4h2v-4h2v-2h-2v-2Zm-4 2h-2v-2h2Zm-12.437 6A5.57 5.57 0 0 1 8 16.437v-2.873A5.57 5.57 0 0 1 13.563 8H18V2h-4.437A11.563 11.563 0 0 0 2 13.563v2.873A11.564 11.564 0 0 0 13.563 28H18v-6Z"/></svg>',
  scala:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><path fill="#f44336" d="m6.457 9.894 12.523 5.163-.456 1.211L6 11.105Zm7.02-3.091L26 11.966l-.457 1.21L13.02 8.015ZM6.465 18.885l12.524 5.163-.457 1.21L6.01 20.097Zm7.007-3.086 12.524 5.163-.456 1.21-12.524-5.162Z"/><path fill="#f44336" d="M6 24.07V30l19.997-3.106V20.96zM6 5.11v5.99l20-3.11V2zm0 9.96v5.03l20-3.11v-5.03z"/></svg>',
  kotlin:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="#7f52ff" d="M2.975 2.976v18.048h18.05v-.03l-4.478-4.511-4.48-4.515 4.48-4.515 4.443-4.477z"/></svg>',
  swift:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="#ff6e40" d="M17.087 19.721c-2.36 1.36-5.59 1.5-8.86.1a13.8 13.8 0 0 1-6.23-5.32c.67.55 1.46 1 2.3 1.4 3.37 1.57 6.73 1.46 9.1 0-3.37-2.59-6.24-5.96-8.37-8.71-.45-.45-.78-1.01-1.12-1.51 8.28 6.05 7.92 7.59 2.41-1.01 4.89 4.94 9.43 7.74 9.43 7.74.16.09.25.16.36.22.1-.25.19-.51.26-.78.79-2.85-.11-6.12-2.08-8.81 4.55 2.75 7.25 7.91 6.12 12.24-.03.11-.06.22-.05.39 2.24 2.83 1.64 5.78 1.35 5.22-1.21-2.39-3.48-1.65-4.62-1.17"/></svg>',
  dart:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><path fill="#4fc3f7" d="M16.83 2a1.3 1.3 0 0 0-.916.377l-.013.01L7.323 7.34l8.556 8.55v.005l10.283 10.277 1.96-3.529-7.068-16.96-3.299-3.297A1.3 1.3 0 0 0 16.828 2Z"/><path fill="#01579b" d="m7.343 7.32-4.955 8.565-.01.013a1.297 1.297 0 0 0 .004 1.835l.005.005 4.106 4.107 16.064 6.314 3.632-2.015-.098-.098-.025.002L15.995 15.97h-.012z"/><path fill="#01579b" d="m7.321 7.324 8.753 8.755h.013L26.16 26.156l3.835-.73L30 14.089l-4.049-3.965a6.5 6.5 0 0 0-3.618-1.612l.002-.043L7.323 7.325Z"/><path fill="#64b5f6" d="m7.332 7.335 8.758 8.75v.013l10.079 10.071L25.436 30H14.09l-3.967-4.048a6.5 6.5 0 0 1-1.611-3.618l-.045.004Z"/></svg>',
  ruby:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="#f44336" d="M18.041 3.177c2.24.382 2.879 1.919 2.843 3.527V6.67l-1.013 13.266-13.132.897h.008c-1.093-.044-3.518-.151-3.634-3.545l1.217-2.222 2.462 5.74 2.097-6.77-.045.009.018-.018 6.85 2.186L13.945 9.3l6.53-.409-5.144-4.212 2.71-1.51v.009M3.113 17.252v.017zM6.916 6.874c2.63-2.622 6.033-4.168 7.34-2.844 1.297 1.306-.072 4.523-2.702 7.135-2.666 2.613-6.015 4.248-7.322 2.933-1.306-1.324.036-4.612 2.675-7.224z"/></svg>',
  php:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="#1e88e5" d="M12 18.08c-6.63 0-12-2.72-12-6.08s5.37-6.08 12-6.08S24 8.64 24 12s-5.37 6.08-12 6.08m-5.19-7.95c.54 0 .91.1 1.09.31.18.2.22.56.13 1.03-.1.53-.29.87-.58 1.09q-.42.33-1.29.33h-.87l.53-2.76zm-3.5 5.55h1.44l.34-1.75h1.23c.54 0 .98-.06 1.33-.17.35-.12.67-.31.96-.58.24-.22.43-.46.58-.73.15-.26.26-.56.31-.88.16-.78.05-1.39-.33-1.82-.39-.44-.99-.65-1.82-.65H4.59zm7.25-8.33-1.28 6.58h1.42l.74-3.77h1.14c.36 0 .6.06.71.18s.13.34.07.66l-.57 2.93h1.45l.59-3.07c.13-.62.03-1.07-.27-1.36-.3-.27-.85-.4-1.65-.4h-1.27L12 7.35zM18 10.13c.55 0 .91.1 1.09.31.18.2.22.56.13 1.03-.1.53-.29.87-.57 1.09-.29.22-.72.33-1.3.33h-.85l.5-2.76zm-3.5 5.55h1.44l.34-1.75h1.22c.55 0 1-.06 1.35-.17.35-.12.65-.31.95-.58.24-.22.44-.46.58-.73.15-.26.26-.56.32-.88.15-.78.04-1.39-.34-1.82-.36-.44-.99-.65-1.82-.65h-2.75z"/></svg>',
  lua:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><path fill="#42a5f5" d="M30 6a3.86 3.86 0 0 1-1.167 2.833 4.024 4.024 0 0 1-5.666 0A3.86 3.86 0 0 1 22 6a3.86 3.86 0 0 1 1.167-2.833 4.024 4.024 0 0 1 5.666 0A3.86 3.86 0 0 1 30 6m-9.208 5.208A10.6 10.6 0 0 0 13 8a10.6 10.6 0 0 0-7.792 3.208A10.6 10.6 0 0 0 2 19a10.6 10.6 0 0 0 3.208 7.792A10.6 10.6 0 0 0 13 30a10.6 10.6 0 0 0 7.792-3.208A10.6 10.6 0 0 0 24 19a10.6 10.6 0 0 0-3.208-7.792m-1.959 7.625a4.024 4.024 0 0 1-5.666 0 4.024 4.024 0 0 1 0-5.666 4.024 4.024 0 0 1 5.666 0 4.024 4.024 0 0 1 0 5.666"/></svg>',
  perl:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="#ba68c8" d="M11.057 2.981c.537.735.028 1.653.141 2.472a3.42 3.42 0 0 1-1.03 2.415c-1.414 1.625-3.165 3.038-4.097 5.03a5.28 5.28 0 0 0 1.412 5.847c.706.735 1.54 1.342 2.472 1.738.17.805-1.088.184-1.455 0A6.7 6.7 0 0 1 4.361 16.4a5.44 5.44 0 0 1 .904-5.368c1.272-1.61 3.136-2.543 4.662-3.857.565-.55 1.003-1.3.932-2.119.156-.678-.254-1.469.212-2.09z"/></svg>',
  r:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="#1976d2" d="M11.956 4.05c-5.694 0-10.354 3.106-10.354 6.947 0 3.396 3.686 6.212 8.531 6.813v2.205h3.53V17.82c.88-.093 1.699-.259 2.475-.497l1.43 2.692h3.996l-2.402-4.048c1.936-1.263 3.147-3.034 3.147-4.97 0-3.841-4.659-6.947-10.354-6.947m1.584 2.712c4.349 0 7.558 1.45 7.558 4.753 0 1.77-.952 3.013-2.505 3.779a1 1 0 0 1-.228-.156c-.373-.165-.994-.352-.994-.352s3.085-.227 3.085-3.302-3.23-3.127-3.23-3.127h-7.092v7.413c-2.64-.766-4.462-2.392-4.462-4.255 0-2.63 3.52-4.753 7.868-4.753m.156 4.12h2.143s.983-.05.983.974c0 1.004-.983 1.004-.983 1.004h-2.143v-1.977m-.031 4.566h.952c.186 0 .28.052.445.207.135.103.28.3.404.476-.57.073-1.17.104-1.801.104z"/></svg>',
  erlang:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 30 30"><path fill="#f44336" d="M5.207 4.33q-.072.075-.143.153Q1.5 8.476 1.5 15.33c0 4.418 1.155 7.862 3.459 10.34h19.415c2.553-1.152 4.127-3.43 4.127-3.43l-3.147-2.52L23.9 21.1c-.867.773-.845.931-2.315 1.78-1.495.674-3.04.966-4.634.966-2.515 0-4.423-.909-5.723-2.059-1.286-1.15-1.985-4.511-2.096-6.68l17.458.067-.183-1.472s-.847-7.129-2.541-9.372zm8.76.846c1.565 0 3.22.535 3.961 1.471.74.937.931 1.667.973 3.524H9.11c.112-1.955.436-2.81 1.373-3.698.936-.887 2.03-1.297 3.484-1.297"/></svg>',
  haskell:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 300"><g stroke-width="2.422"><path fill="#ef5350" d="m23.928 240.5 59.94-89.852-59.94-89.855h44.955l59.94 89.855-59.94 89.852z"/><path fill="#ffa726" d="m83.869 240.5 59.94-89.852-59.94-89.855h44.955l119.88 179.71h-44.95l-37.46-56.156-37.468 56.156z"/><path fill="#ffee58" d="m228.72 188.08-19.98-29.953h69.93v29.956h-49.95zm-29.97-44.924-19.98-29.953h99.901v29.953z"/></g></svg>',
  clojure:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256"><path fill="#64dd17" d="M123.456 129.975a507 507 0 0 0-3.54 7.846c-4.406 9.981-9.284 22.127-11.066 29.908-.64 2.77-1.037 6.205-1.03 10.013 0 1.506.081 3.09.21 4.702a58.1 58.1 0 0 0 19.98 3.559 58.2 58.2 0 0 0 18.29-2.98c-1.352-1.237-2.642-2.554-3.816-4.038-7.796-9.942-12.146-24.512-19.028-49.01"/></svg>',

  // ── Shell / build / infra ─────────────────────────────────────────────────
  shell:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path fill="#ff7043" d="M2 2a1 1 0 0 0-1 1v10c0 .554.446 1 1 1h12c.554 0 1-.446 1-1V3a1 1 0 0 0-1-1zm0 3h12v8H2zm1 2 2 2-2 2 1 1 3-3-3-3zm5 3.5V12h5v-1.5z"/></svg>',
  docker:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="#0288d1" d="M21.81 10.25c-.06-.04-.56-.43-1.64-.43-.28 0-.56.03-.84.08-.21-1.4-1.38-2.11-1.43-2.14l-.29-.17-.18.27c-.24.36-.43.77-.51 1.19-.2.8-.08 1.56.33 2.21-.49.28-1.29.35-1.46.35H2.62c-.34 0-.62.28-.62.63 0 1.15.18 2.3.58 3.38.45 1.19 1.13 2.07 2 2.61.98.6 2.59.94 4.42.94.79 0 1.61-.07 2.42-.22 1.12-.2 2.2-.59 3.19-1.16A8.3 8.3 0 0 0 16.78 16c1.05-1.17 1.67-2.5 2.12-3.65h.19c1.14 0 1.85-.46 2.24-.85.26-.24.45-.53.59-.87l.08-.24zm-17.96.99h1.76c.08 0 .16-.07.16-.16V9.5c0-.08-.07-.16-.16-.16H3.85c-.09 0-.16.07-.16.16v1.58c.01.09.07.16.16.16m2.43 0h1.76c.08 0 .16-.07.16-.16V9.5c0-.08-.07-.16-.16-.16H6.28c-.09 0-.16.07-.16.16v1.58c.01.09.07.16.16.16m2.47 0h1.75c.1 0 .17-.07.17-.16V9.5c0-.08-.06-.16-.17-.16H8.75c-.08 0-.15.07-.15.16v1.58c0 .09.06.16.15.16m2.44 0h1.77c.08 0 .15-.07.15-.16V9.5c0-.08-.06-.16-.15-.16h-1.77c-.08 0-.15.07-.15.16v1.58c0 .09.07.16.15.16M6.28 9h1.76c.08 0 .16-.09.16-.18V7.25c0-.09-.07-.16-.16-.16H6.28c-.09 0-.16.06-.16.16v1.57c.01.09.07.18.16.18m2.47 0h1.75c.1 0 .17-.09.17-.18V7.25c0-.09-.06-.16-.17-.16H8.75c-.08 0-.15.06-.15.16v1.57c0 .09.06.18.15.18m2.44 0h1.77c.08 0 .15-.09.15-.18V7.25c0-.09-.07-.16-.15-.16h-1.77c-.08 0-.15.06-.15.16v1.57c0 .09.07.18.15.18m0-2.28h1.77c.08 0 .15-.07.15-.16V5c0-.1-.07-.17-.15-.17h-1.77c-.08 0-.15.06-.15.17v1.56c0 .08.07.16.15.16m2.46 4.52h1.76c.09 0 .16-.07.16-.16V9.5c0-.08-.07-.16-.16-.16h-1.76c-.08 0-.15.07-.15.16v1.58c0 .09.07.16.15.16"/></svg>',
  makefile:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><path fill="#ef5350" d="m29.5 24.02-1.6-.92a4.4 4.4 0 0 0 .09-.9A1.3 1.3 0 0 0 28 22a5.6 5.6 0 0 0-.1-1.1l1.6-.92a.493.493 0 0 0 .18-.68l-1.5-2.6a.45.45 0 0 0-.18-.18V6.01a2.006 2.006 0 0 0-2-2H4a2.006 2.006 0 0 0-2 2V22a2.006 2.006 0 0 0 2 2h10.53l-.03.02a.493.493 0 0 0-.18.68l1.5 2.6a.493.493 0 0 0 .68.18l1.6-.92a5.9 5.9 0 0 0 1.9 1.09v1.85a.495.495 0 0 0 .5.5h3a.495.495 0 0 0 .5-.5v-1.85a5.9 5.9 0 0 0 1.9-1.09l1.6.92a.493.493 0 0 0 .68-.18l1.5-2.6a.493.493 0 0 0-.18-.68M24 22.01a1.99 1.99 0 0 1-.88 1.65l-.18.11a2.04 2.04 0 0 1-1.88 0l-.18-.11a1.99 1.99 0 0 1-.88-1.65V22a2 2 0 0 1 .88-1.66l.18-.11a2.04 2.04 0 0 1 1.88 0l.18.11A2 2 0 0 1 24 22Zm2-4.63-.1.06a5.9 5.9 0 0 0-1.9-1.09V14.5a.495.495 0 0 0-.5-.5h-3a.495.495 0 0 0-.5.5v1.85a5.9 5.9 0 0 0-1.9 1.09l-1.6-.92a.493.493 0 0 0-.68.18l-1.5 2.6a.493.493 0 0 0 .18.68l1.6.92A5.6 5.6 0 0 0 16 22v.01L4 22V10.01h22Z"/></svg>',
  database:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><path fill="#ffca28" d="M16 24c-5.525 0-10-.9-10-2v4c0 1.1 4.475 2 10 2s10-.9 10-2v-4c0 1.1-4.475 2-10 2m0-8c-5.525 0-10-.9-10-2v4c0 1.1 4.475 2 10 2s10-.9 10-2v-4c0 1.1-4.475 2-10 2m0-12C10.477 4 6 4.895 6 6v4c0 1.1 4.475 2 10 2s10-.9 10-2V6c0-1.105-4.477-2-10-2"/></svg>',
  yaml:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="#ff5252" d="M13 9h5.5L13 3.5zM6 2h8l6 6v12c0 1.1-.9 2-2 2H6c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2m12 16v-2H9v2zm-4-4v-2H6v2z"/></svg>',
  toml:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path fill="#cfd8dc" d="M4 6V4h8v2H9v7H7V6z"/><path fill="#ef5350" d="M4 1v1H2v12h2v1H1V1zm8 0v1h2v12h-2v1h3V1z"/></svg>',
  settings:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="#42a5f5" d="M19.43 12.98c.04-.32.07-.64.07-.98s-.03-.66-.07-.98l2.11-1.65c.19-.15.24-.42.12-.64l-2-3.46a.5.5 0 0 0-.61-.22l-2.49 1c-.52-.4-1.08-.73-1.69-.98l-.38-2.65A.49.49 0 0 0 14 2h-4c-.25 0-.46.18-.49.42l-.38 2.65c-.61.25-1.17.59-1.69.98l-2.49-1a.6.6 0 0 0-.18-.03c-.17 0-.34.09-.43.25l-2 3.46c-.13.22-.07.49.12.64l2.11 1.65c-.04.32-.07.65-.07.98s.03.66.07.98l-2.11 1.65c-.19.15-.24.42-.12.64l2 3.46a.5.5 0 0 0 .61.22l2.49-1c.52.4 1.08.73 1.69.98l.38 2.65c.03.24.24.42.49.42h4c.25 0 .46-.18.49-.42l.38-2.65c.61-.25 1.17-.59 1.69-.98l2.49 1q.09.03.18.03c.17 0 .34-.09.43-.25l2-3.46c.12-.22.07-.49-.12-.64zM12 15.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7"/></svg>',
  git:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="#e64a19" d="M12 .5 11 1.6 8.9 3.7 3.7 8.9 1.6 11 .5 12l1.1 1.1L11 22.5l1.1 1.1 1.1-1.1 8.7-8.7 1.1-1.1-1.1-1.1-8.7-8.7L12 .5m0 3.6L20.4 12 12 20.4 3.6 12z"/></svg>',
  lock:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><path fill="#ffd54f" d="M25 12h-3V8a6 6 0 0 0-12 0v4H7a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h18a1 1 0 0 0 1-1V13a1 1 0 0 0-1-1M14 8a2 2 0 0 1 4 0v4h-4Zm2 17a4 4 0 1 1 4-4 4 4 0 0 1-4 4"/></svg>',
  pdf:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="#e53935" d="M13 9h5.5L13 3.5zM6 2h8l6 6v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2m1 9v2h2.5v6h2v-6H14v-2zm5 0v8h2v-2.5h1.5a1.5 1.5 0 0 0 1.5-1.5v-3A1.5 1.5 0 0 0 15.5 11Zm2 2h1v2h-1z"/></svg>',
  zip:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="#ffb300" d="M13 9h5.5L13 3.5zM6 2h8l6 6v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2m4 2v2h2V4zm2 3v2h-2V7zm-2 3v2h2v-2zm2 3v2h-2v-2zm-2 3v3h2v-3z"/></svg>',
  image:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="#26a69a" d="M8.5 13.5 11 16.5 14.5 12l4.5 6H5zM13 9h5.5L13 3.5zM6 2h8l6 6v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2"/></svg>',

  // ── Mobile ────────────────────────────────────────────────────────────────
  flutter:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="#42a5f5" d="M14.314 0 2.7 12L6 15.3 21.314 0z"/><path fill="#42a5f5" d="M14.314 0 2.7 12L6 15.3 21.314 0z"/><path fill="#0d47a1" d="M14.314 0 2.7 12L6 15.3 21.314 0z"/><path fill="#42a5f5" d="M14.314 0 2.7 12L6 15.3 21.314 0z"/><path fill="#0d47a1" d="m21.3 9.3-6.6 6.6 3.3 3.3L24 12.9V6z"/><path fill="#42a5f5" d="m6 15.3 3.3 3.3 6.6-6.6H9.3z"/><path fill="#0d47a1" d="m14.7 18.6-3.3 3.3 3.3 3.3H24l-6-6.6z"/></svg>',
  android:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="#8bc34a" d="M17.6 9.48l1.84-3.18c.16-.31.04-.69-.26-.85a.637.637 0 0 0-.83.22l-1.88 3.24a11.5 11.5 0 0 0-8.94 0L5.65 5.67a.643.643 0 0 0-.87-.2c-.28.18-.37.54-.22.83L6.4 9.48A10.78 10.78 0 0 0 1 18h22a10.78 10.78 0 0 0-5.4-8.52M7 15.25a1.25 1.25 0 1 1 0-2.5 1.25 1.25 0 0 1 0 2.5m10 0a1.25 1.25 0 1 1 0-2.5 1.25 1.25 0 0 1 0 2.5"/></svg>',
  apple:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="#b0bec5" d="M18.71 19.5c-.83 1.24-1.71 2.45-3.05 2.47-1.34.03-1.77-.79-3.29-.79-1.53 0-2.005.77-3.27.82-1.31.05-2.3-1.32-3.14-2.53C4.25 17 2.94 12.45 4.7 9.39c.87-1.52 2.43-2.48 4.12-2.51 1.28-.02 2.5.87 3.29.87.78 0 2.26-1.07 3.81-.91.65.03 2.47.26 3.64 1.98-.09.06-2.17 1.28-2.15 3.81.03 3.02 2.65 4.03 2.68 4.04-.03.07-.42 1.44-1.38 2.83M13 3.5c.73-.83 1.94-1.46 2.94-1.5.13 1.17-.34 2.35-1.04 3.19-.69.85-1.83 1.51-2.95 1.42-.15-1.15.41-2.35 1.05-3.11"/></svg>',
  capacitor:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="#53b9ff" d="M12 2 2 12l10 10 10-10zm0 3.6 6.4 6.4-6.4 6.4-6.4-6.4z"/><circle cx="12" cy="12" r="3" fill="#53b9ff"/></svg>',
  ionic:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="#4e8df2" d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20m0 17.5a7.5 7.5 0 1 1 0-15 7.5 7.5 0 0 1 0 15"/><circle cx="12" cy="12" r="3.6" fill="#4e8df2"/><circle cx="18" cy="6" r="2.4" fill="#fff"/></svg>',
};

// ── Mappings déclaratifs ─────────────────────────────────────────────────────

/** Nom de fichier exact (minuscules) → clé d'icône. */
const FILE_NAMES: Record<string, string> = {
  dockerfile: 'docker',
  'dockerfile.dev': 'docker',
  'dockerfile.prod': 'docker',
  'docker-compose.yml': 'docker',
  'docker-compose.yaml': 'docker',
  '.dockerignore': 'docker',
  makefile: 'makefile',
  'cmakelists.txt': 'makefile',
  '.gitignore': 'git',
  '.gitattributes': 'git',
  '.gitmodules': 'git',
  '.git': 'git',
  'package.json': 'json',
  'package-lock.json': 'lock',
  'npm-shrinkwrap.json': 'lock',
  'yarn.lock': 'lock',
  'pnpm-lock.yaml': 'lock',
  'tsconfig.json': 'typescript',
  'jsconfig.json': 'javascript',
  'cargo.toml': 'toml',
  'cargo.lock': 'lock',
  'go.mod': 'go',
  'go.sum': 'lock',
  'requirements.txt': 'python',
  'pyproject.toml': 'toml',
  'poetry.lock': 'lock',
  'pipfile': 'python',
  'pipfile.lock': 'lock',
  gemfile: 'ruby',
  'gemfile.lock': 'lock',
  rakefile: 'ruby',
  license: 'lock',
  'license.txt': 'lock',
  'license.md': 'markdown',
  'license.rst': 'markdown',
  'readme.md': 'markdown',
  'readme.txt': 'markdown',
  readme: 'markdown',
  // ── Marqueurs de projets mobiles ──────────────────────────────────────────
  'pubspec.yaml': 'dart',
  'pubspec.lock': 'lock',
  'podfile': 'apple',
  'podfile.lock': 'lock',
  'settings.gradle': 'android',
  'settings.gradle.kts': 'android',
  'build.gradle': 'android',
  'build.gradle.kts': 'android',
  'gradle.properties': 'android',
  'androidmanifest.xml': 'android',
  'info.plist': 'apple',
  'capacitor.config.json': 'capacitor',
  'capacitor.config.ts': 'capacitor',
  'ionic.config.json': 'ionic',
};

/** Extension (sans point, minuscules) → clé d'icône. */
const FILE_EXTENSIONS: Record<string, string> = {
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  tsx: 'react_ts',
  d: 'typescript',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'react',
  css: 'css',
  scss: 'sass',
  sass: 'sass',
  less: 'sass',
  html: 'html',
  htm: 'html',
  vue: 'html',
  json: 'json',
  jsonc: 'json',
  json5: 'json',
  md: 'markdown',
  markdown: 'markdown',
  mdx: 'markdown',
  rst: 'markdown',
  xml: 'xml',
  plist: 'apple',
  storyboard: 'apple',
  xib: 'apple',
  svg: 'image',
  rs: 'rust',
  py: 'python',
  pyi: 'python',
  pyw: 'python',
  ipynb: 'python',
  go: 'go',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  hh: 'cpp',
  hxx: 'cpp',
  java: 'java',
  cs: 'csharp',
  scala: 'scala',
  sc: 'scala',
  kt: 'kotlin',
  kts: 'kotlin',
  gradle: 'android',
  swift: 'swift',
  dart: 'dart',
  rb: 'ruby',
  rake: 'ruby',
  gemspec: 'ruby',
  php: 'php',
  lua: 'lua',
  pl: 'perl',
  pm: 'perl',
  r: 'r',
  rmd: 'r',
  erl: 'erlang',
  hrl: 'erlang',
  hs: 'haskell',
  lhs: 'haskell',
  clj: 'clojure',
  cljs: 'clojure',
  cljc: 'clojure',
  edn: 'clojure',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  fish: 'shell',
  ksh: 'shell',
  dockerfile: 'docker',
  mk: 'makefile',
  cmake: 'makefile',
  db: 'database',
  sqlite: 'database',
  sqlite3: 'database',
  sql: 'database',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'toml',
  ini: 'settings',
  cfg: 'settings',
  conf: 'settings',
  env: 'settings',
  lock: 'lock',
  pdf: 'pdf',
  zip: 'zip',
  gz: 'zip',
  tar: 'zip',
  rar: 'zip',
  '7z': 'zip',
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  gif: 'image',
  webp: 'image',
  bmp: 'image',
  ico: 'image',
  avif: 'image',
};

/** Clés d'icônes exposées par le registre `lib/languages.ts` → clé du catalogue. */
const ICON_KEY_ALIASES: Record<string, string> = {
  tsx: 'react_ts',
  jsx: 'react',
};

/** Clé renvoyée quand rien ne matche. */
const KEY_FILE = 'file';
const KEY_FOLDER = 'folder';

/**
 * Choisit la clé d'icône pour un nom donné, par ordre de spécificité :
 *  1. clé de langage fournie par le registre (`languageIcon`) ;
 *  2. nom de fichier exact ;
 *  3. extension ;
 *  4. repli générique (`file` / `folder`).
 */
function pickKey(name: string, isDir: boolean, languageIcon: string | null): string {
  if (isDir) return KEY_FOLDER;

  if (languageIcon) {
    const alias = ICON_KEY_ALIASES[languageIcon] ?? languageIcon;
    if (ICONS[alias]) return alias;
  }

  const lower = name.toLowerCase();

  const byName = FILE_NAMES[lower];
  if (byName) return byName;

  const dot = lower.lastIndexOf('.');
  if (dot >= 0 && dot < lower.length - 1) {
    const ext = lower.slice(dot + 1);
    const byExt = FILE_EXTENSIONS[ext];
    if (byExt) return byExt;
  }

  return KEY_FILE;
}

// ── Encodage data-URI ───────────────────────────────────────────────────────

const uriCache = new Map<string, string>();

/** Encode un SVG en data-URI `image/svg+xml` utilisable dans un `<img src>`. */
function iconDataUri(svg: string): string {
  const cached = uriCache.get(svg);
  if (cached) return cached;
  // `encodeURIComponent` : encode `#`, `<`, `>`, guillemets… → data-URI sûre.
  const uri = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  uriCache.set(svg, uri);
  return uri;
}

/** Data-URI de l'icône dossier (le glyphe est identique fermé/ouvert). */
function folderUri(_expanded: boolean): string {
  return iconDataUri(GLYPH_FOLDER);
}

/**
 * Résout l'icône Material d'un fichier ou dossier en data-URI.
 *
 * @param name        nom de base (fichier ou dossier)
 * @param isDir       vrai pour un dossier
 * @param expanded    état d'expansion (dossier)
 * @param languageIcon clé de langage éventuelle fournie par `lib/languages.ts`
 * @returns une data-URI `image/svg+xml` (jamais `null`).
 */
export function resolveMaterialIcon(
  name: string,
  isDir: boolean,
  expanded: boolean,
  languageIcon: string | null = null,
): string {
  if (isDir) return folderUri(expanded);
  const key = pickKey(name, isDir, languageIcon);
  return iconDataUri(ICONS[key] ?? GLYPH_FILE);
}

/**
 * Data-URI d'une icône Material résolue **par clé directe** (sans nom de
 * fichier). Utile pour afficher une icône de technologie (framework mobile)
 * ailleurs que dans l'explorateur. Retombe sur le glyphe `file` si la clé est
 * inconnue — jamais `null`.
 */
export function materialIconByKey(key: string | null | undefined): string {
  const resolved = key ? (ICON_KEY_ALIASES[key] ?? key) : KEY_FILE;
  return iconDataUri(ICONS[resolved] ?? GLYPH_FILE);
}