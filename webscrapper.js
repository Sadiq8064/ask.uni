// webscrapper.js
// Pure Node.js web crawler based on your Python FastAPI logic
// Usage:
//   const { scrapeWebsite } = require('./webscrapper');
//   const pages = await scrapeWebsite('https://example.com');

const axios = require('axios');
const cheerio = require('cheerio');
const { URL } = require('url');

// ---------------- CONFIG ----------------
const DEFAULT_MAX_PAGES = 10;
const DEFAULT_MAX_DEPTH = 2;
const DEFAULT_CONCURRENCY = 10;
const HEADERS = { 'User-Agent': 'Mozilla/5.0 (Node WebScraper)' };
const CHUNK_SIZE = 800; // ~800 words per chunk
// ----------------------------------------

// ---------------- UTILS ----------------

function isInternal(base, link) {
    try {
        const baseUrl = new URL(base);
        const full = new URL(link, baseUrl);
        return baseUrl.hostname === full.hostname;
    } catch {
        return false;
    }
}

function isLoginPage(url) {
    const u = (url || '').toLowerCase();
    return (
        u.includes('login') ||
        u.includes('signin') ||
        u.includes('auth') ||
        u.includes('account')
    );
}

function isTracking(url) {
    const u = (url || '').toLowerCase();
    return (
        u.includes('utm_') ||
        u.includes('ref=') ||
        u.includes('tracking') ||
        u.includes('gclid') ||
        u.includes('fbclid')
    );
}

function chunkText(text, chunkSize = CHUNK_SIZE) {
    const words = (text || '').split(/\s+/).filter(Boolean);
    const chunks = [];

    for (let i = 0; i < words.length; i += chunkSize) {
        const chunkWords = words.slice(i, i + chunkSize);
        const chunk = chunkWords.join(' ').trim();
        if (chunk) chunks.push(chunk);
    }

    return chunks;
}

// -------- Extract Media --------

function extractMedia($, baseUrl) {
    const pdfs = [];
    const images = [];

    $('a[href]').each((_, el) => {
        const href = $(el).attr('href');
        if (!href) return;
        if (href.toLowerCase().endsWith('.pdf')) {
            try {
                const full = new URL(href, baseUrl).toString();
                pdfs.push({
                    name: full.split('/').pop() || 'file.pdf',
                    url: full
                });
            } catch {
                // ignore invalid URLs
            }
        }
    });

    $('img[src]').each((_, el) => {
        const src = ($(el).attr('src') || '').toLowerCase();
        if (!src) return;
        const exts = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg'];
        if (!exts.some(ext => src.endsWith(ext))) return;

        try {
            const full = new URL(src, baseUrl).toString();
            images.push({
                name: full.split('/').pop() || 'image',
                url: full
            });
        } catch {
            // ignore invalid URLs
        }
    });

    return [pdfs, images];
}

// -------- Extract Dynamic API URLs --------

function extractDynamicApiUrls(html, baseUrl) {
    const patterns = [
        /["'](\/api\/[^"']+)["']/gi,
        /["'](\/[A-Za-z0-9/_-]*Get[A-Za-z0-9/_-]+)["']/gi,
        /["'](\/[A-Za-z0-9/_-]*Fetch[A-Za-z0-9/_-]+)["']/gi,
        /["'](\/[A-Za-z0-9/_-]*detail[A-Za-z0-9/_-]+)["']/gi,
        /["'](\/[A-Za-z0-9/_-]*overview[A-Za-z0-9/_-]+)["']/gi,
        /["'](\/Course\/[A-Za-z0-9/_-]+)["']/gi
    ];

    const apiUrls = new Set();

    for (const regex of patterns) {
        let match;
        while ((match = regex.exec(html)) !== null) {
            const rel = match[1];
            try {
                const full = new URL(rel, baseUrl).toString();
                apiUrls.add(full);
            } catch {
                continue;
            }
        }
    }

    return Array.from(apiUrls);
}

// -------- Extract text from JSON (API responses) --------

function extractTextFromJson(data) {
    const texts = [];

    function recurse(val) {
        if (val == null) return;

        if (Array.isArray(val)) {
            for (const item of val) recurse(item);
        } else if (typeof val === 'object') {
            for (const k of Object.keys(val)) recurse(val[k]);
        } else if (typeof val === 'string') {
            if (val.trim().split(/\s+/).length > 3) {
                texts.push(val.trim());
            }
        }
    }

    recurse(data);
    return texts;
}

// -------- Extract Clean HTML Text --------

function extractCleanHtmlText($) {
    const removeTags = ['script', 'style', 'nav', 'header', 'footer', 'noscript', 'form', 'aside'];
    removeTags.forEach(tag => $(tag).remove());

    const textParts = [];

    // headings
    $('h1, h2, h3').each((_, el) => {
        const txt = $(el).text().replace(/\s+/g, ' ').trim();
        if (txt) textParts.push(txt);
    });

    // paragraphs
    $('p').each((_, el) => {
        const txt = $(el).text().replace(/\s+/g, ' ').trim();
        if (txt && txt.split(/\s+/).length > 5) {
            textParts.push(txt);
        }
    });

    return textParts.join('\n').trim();
}

// ------------------- SINGLE PAGE SCRAPER -------------------

async function crawlSingle({ url, depth, baseUrl, visited, maxDepth, maxPages }) {
    if (depth > maxDepth) return null;
    if (isLoginPage(url) || isTracking(url)) return null;

    if (visited.has(url) || visited.size >= maxPages) return null;
    visited.add(url);

    console.log(`[Crawling] ${url}`);

    let html;
    let $;

    try {
        const resp = await axios.get(url, {
            headers: HEADERS,
            timeout: 15000
        });
        html = resp.data;
        $ = cheerio.load(html);
    } catch (err) {
        console.error(`[Error] fetching ${url}:`, err.message);
        return null;
    }

    // static HTML text
    const htmlText = extractCleanHtmlText($);

    // PDFs & images
    const [pdfs, images] = extractMedia($, url);

    // dynamic API URLs
    const apiUrls = extractDynamicApiUrls(html, url);
    const apiTextParts = [];

    for (const apiUrl of apiUrls) {
        try {
            const resp = await axios.get(apiUrl, {
                headers: HEADERS,
                timeout: 10000
            });

            let jsonData = null;

            if (typeof resp.data === 'object') {
                jsonData = resp.data;
            } else {
                const ct = (resp.headers['content-type'] || '').toLowerCase();
                if (ct.includes('application/json')) {
                    jsonData = resp.data;
                } else {
                    try {
                        jsonData = JSON.parse(resp.data);
                    } catch {
                        jsonData = null;
                    }
                }
            }

            if (jsonData) {
                apiTextParts.push(...extractTextFromJson(jsonData));
            }
        } catch {
            // ignore API errors
            continue;
        }
    }

    const fullText = [htmlText, ...apiTextParts].filter(Boolean).join('\n').trim();
    const chunks = chunkText(fullText);

    const pageData = {
        url,
        chunks,
        pdfs,
        images
    };

    // collect next internal links
    const nextLinks = [];
    $('a[href]').each((_, el) => {
        const href = $(el).attr('href');
        if (!href) return;
        try {
            const nextUrl = new URL(href, url).toString();
            if (isInternal(baseUrl, nextUrl)) {
                nextLinks.push({ url: nextUrl, depth: depth + 1 });
            }
        } catch {
            // ignore invalid URLs
        }
    });

    return { pageData, nextLinks };
}

// ------------------- MAIN SCRAPER FUNCTION -------------------

/**
 * Crawl a website and return an array of page objects:
 *
 *   {
 *     url,
 *     chunks: [...],
 *     pdfs: [{ name, url }],
 *     images: [{ name, url }]
 *   },
 *   ...
 *
 *
 * @param {string} startUrl
 * @param {object} options
 * @param {number} options.maxPages
 * @param {number} options.maxDepth
 * @param {number} options.concurrency
 * @returns {Promise<Array>}
 */
async function scrapeWebsite(startUrl, options = {}) {
    const maxPages = options.maxPages || DEFAULT_MAX_PAGES;
    const maxDepth = options.maxDepth || DEFAULT_MAX_DEPTH;
    const concurrency = options.concurrency || DEFAULT_CONCURRENCY;

    const visited = new Set();
    const results = [];

    let queue = [{ url: startUrl, depth: 0 }];

    while (queue.length > 0 && visited.size < maxPages) {
        // take a batch based on concurrency
        const batch = queue.splice(0, concurrency);
        const tasks = batch.map(item =>
            crawlSingle({
                url: item.url,
                depth: item.depth,
                baseUrl: startUrl,
                visited,
                maxDepth,
                maxPages
            })
        );

        const batchResults = await Promise.all(tasks);
        const nextQueue = [];

        for (const res of batchResults) {
            if (!res) continue;
            results.push(res.pageData);

            if (res.nextLinks && res.nextLinks.length > 0) {
                for (const ln of res.nextLinks) {
                    // We don't check visited here because crawlSingle will
                    // ignore already visited URLs, but we can also filter duplicates:
                    if (!visited.has(ln.url)) {
                        nextQueue.push(ln);
                    }
                }
            }
        }

        queue = queue.concat(nextQueue);
    }

    return results;
}

module.exports = {
    scrapeWebsite
};
