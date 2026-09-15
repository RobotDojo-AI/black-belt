/*
 * Shared analytics loader for Robot Dojo marketing pages.
 *
 * Reads IDs from meta tags so HTML stays the single source of configuration:
 *   <meta name="ga-id" content="G-XXXXXXX">
 *   <meta name="clarity-id" content="xxxxxxxxxx">
 *
 * Empty / missing IDs skip loading entirely, so local dev does not spam
 * analytics and non-instrumented pages cost nothing.
 *
 * No dependencies. Pure vanilla JS. Safe to include with `defer`.
 */

(function () {
  'use strict';

  if (/^(localhost|127\.0\.0\.1|\[::1\])$/.test(window.location.hostname)) return;

  function readMeta(name) {
    var el = document.querySelector('meta[name="' + name + '"]');
    if (!el) return '';
    var v = el.getAttribute('content');
    return (v || '').trim();
  }

  var gaId = readMeta('ga-id');
  var clarityId = readMeta('clarity-id');

  // Google Analytics 4 (gtag.js) ----------------------------------------
  if (gaId) {
    var gaScript = document.createElement('script');
    gaScript.async = true;
    gaScript.src = 'https://www.googletagmanager.com/gtag/js?id=' + encodeURIComponent(gaId);
    document.head.appendChild(gaScript);

    window.dataLayer = window.dataLayer || [];
    function gtag() { window.dataLayer.push(arguments); }
    window.gtag = gtag;
    gtag('js', new Date());
    gtag('config', gaId);
  }

  // Microsoft Clarity ---------------------------------------------------
  if (clarityId) {
    (function (c, l, a, r, i, t, y) {
      c[a] = c[a] || function () { (c[a].q = c[a].q || []).push(arguments); };
      t = l.createElement(r);
      t.async = 1;
      t.src = 'https://www.clarity.ms/tag/' + i;
      y = l.getElementsByTagName(r)[0];
      y.parentNode.insertBefore(t, y);
    })(window, document, 'clarity', 'script', clarityId);
  }
})();
