const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Session storage path
const SESSION_FILE = path.join(__dirname, 'browser-session.json');

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static('public'));

// ============================================
// API KEY CONFIGURATION
// ============================================
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || 
const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';

// Create necessary directories
const ensureDirectories = () => {
    const dirs = ['public/screenshots', 'public/downloads', 'public/videos'];
    dirs.forEach(dir => {
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
    });
};
ensureDirectories();

// ============================================
// BROWSER AUTOMATION HELPERS
// ============================================

async function openSite(page, url) {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(6000);
}

function detectLoginPage(url, page) {
    const loginPatterns = [
        '/login', '/signin', '/auth', '/ap/signin',
        'accounts.google', 'login.live', 'account/login',
        'captcha', 'robot_check'
    ];
    return loginPatterns.some(pattern => url.toLowerCase().includes(pattern));
}

function detectCheckoutPage(url) {
    const checkoutPatterns = [
        '/checkout', '/payment', '/buy', '/place-order',
        '/confirm-order', '/billing', '/pay'
    ];
    return checkoutPatterns.some(pattern => url.toLowerCase().includes(pattern));
}

async function waitForUserLogin(page) {
    console.log('⏸️  Waiting for manual login...');
    
    try {
        await page.waitForFunction(() => {
            const url = window.location.href.toLowerCase();
            return !url.includes('/login') && 
                   !url.includes('/signin') && 
                   !url.includes('/auth') &&
                   !url.includes('/ap/signin');
        }, { timeout: 300000 });
        
        await page.waitForTimeout(6000);
        console.log('✅ Login detected, resuming automation');
        return true;
    } catch (e) {
        console.log('❌ Login timeout');
        return false;
    }
}

async function saveSession(context) {
    try {
        const state = await context.storageState();
        fs.writeFileSync(SESSION_FILE, JSON.stringify(state, null, 2));
        console.log('💾 Session saved');
    } catch (e) {
        console.log('⚠️  Could not save session');
    }
}

async function loadSession(context) {
    try {
        if (fs.existsSync(SESSION_FILE)) {
            const state = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
            await context.addCookies(state.cookies);
            console.log('✅ Session loaded');
            return true;
        }
    } catch (e) {
        console.log('⚠️  Could not load session');
    }
    return false;
}

async function searchAmazon(page, query) {
    try {
        const selector = 'input#twotabsearchtextbox, input[name="field-keywords"]';
        
        console.log('🔍 Searching Amazon for:', query);
        
        await page.waitForSelector(selector, { timeout: 10000 });
        await page.click(selector);
        await page.fill(selector, '');
        await page.fill(selector, query);
        await page.waitForTimeout(1000);
        await page.keyboard.press('Enter');
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(4000);
        
        return true;
    } catch (e) {
        console.log('⚠️  Search failed:', e.message);
        return false;
    }
}

// ============================================
// UNIVERSAL PRODUCT EXTRACTION ENGINE
// ============================================

// Helper: Scroll to load lazy images
async function scrollAndWait(page, scrolls = 3) {
    for (let i = 0; i < scrolls; i++) {
        await page.evaluate(() => window.scrollBy(0, window.innerHeight));
        await page.waitForTimeout(1000);
    }
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(500);
}

// Amazon Extractor - Enhanced with Multiple Selectors
async function extractAmazonProducts(page) {
    await scrollAndWait(page, 5); // More scrolling for Amazon
    await page.waitForTimeout(2000);
    
    const products = await page.evaluate(() => {
        const results = [];
        
        // Try multiple container selectors
        let containers = document.querySelectorAll('[data-component-type="s-search-result"]');
        if (containers.length === 0) {
            containers = document.querySelectorAll('div[data-asin]:not([data-asin=""])');
        }
        if (containers.length === 0) {
            containers = document.querySelectorAll('.s-result-item[data-asin]');
        }
        
        console.log('Amazon: Found', containers.length, 'containers');
        
        containers.forEach((item, index) => {
            try {
                const asin = item.getAttribute('data-asin');
                if (!asin || asin === '') return;
                
                // Title - multiple selectors
                let titleElement = item.querySelector('h2 a span');
                if (!titleElement) titleElement = item.querySelector('h2 span');
                if (!titleElement) titleElement = item.querySelector('.a-text-normal');
                
                let linkElement = item.querySelector('h2 a');
                if (!linkElement) linkElement = item.querySelector('a.a-link-normal');
                
                if (!titleElement || !linkElement) return;
                
                const title = titleElement.textContent.trim();
                const url = linkElement.href;
                
                if (!title || !url) return;
                
                // Price - multiple methods
                let price = '';
                const priceWhole = item.querySelector('.a-price-whole');
                const priceFraction = item.querySelector('.a-price-fraction');
                
                if (priceWhole) {
                    const whole = priceWhole.textContent.replace(/[,\.]/g, '').trim();
                    const fraction = priceFraction ? priceFraction.textContent.trim() : '00';
                    price = `₹${whole}.${fraction}`;
                } else {
                    const priceText = item.querySelector('.a-price .a-offscreen');
                    if (priceText) {
                        price = priceText.textContent.trim();
                    } else {
                        const priceSymbol = item.querySelector('.a-price-symbol');
                        const priceValue = item.querySelector('.a-price span:not(.a-price-symbol)');
                        if (priceSymbol && priceValue) {
                            price = priceSymbol.textContent + priceValue.textContent;
                        }
                    }
                }
                
                // Rating
                const ratingElement = item.querySelector('.a-icon-alt');
                let rating = '';
                if (ratingElement) {
                    const ratingText = ratingElement.textContent.trim();
                    rating = ratingText.split(' ')[0];
                }
                
                // Reviews
                let reviewCount = '';
                const reviewElement = item.querySelector('span[aria-label*="stars"]');
                if (reviewElement && reviewElement.parentElement) {
                    const reviewsSpan = reviewElement.parentElement.nextElementSibling;
                    if (reviewsSpan) reviewCount = reviewsSpan.textContent.trim();
                }
                if (!reviewCount) {
                    const altReview = item.querySelector('.a-size-base.s-underline-text');
                    if (altReview) reviewCount = altReview.textContent.trim();
                }
                
                // Image - Enhanced extraction
                let imageUrl = '';
                const imgElement = item.querySelector('img.s-image') || item.querySelector('img');
                
                if (imgElement) {
                    // Try src
                    imageUrl = imgElement.src || '';
                    
                    // If placeholder, try srcset
                    if (!imageUrl || imageUrl.startsWith('data:') || imageUrl.includes('transparent-pixel') || imageUrl.includes('1x1')) {
                        const srcset = imgElement.getAttribute('srcset');
                        if (srcset) {
                            const sources = srcset.split(',');
                            for (let src of sources) {
                                const url = src.trim().split(' ')[0];
                                if (url && url.startsWith('http') && !url.includes('1x1')) {
                                    imageUrl = url;
                                    break;
                                }
                            }
                        }
                    }
                    
                    // Try data-src
                    if (!imageUrl || imageUrl.startsWith('data:')) {
                        imageUrl = imgElement.getAttribute('data-src') || '';
                    }
                    
                    // Try loading attribute
                    if (!imageUrl || imageUrl.startsWith('data:')) {
                        const lazyImg = imgElement.getAttribute('data-old-hires');
                        if (lazyImg) imageUrl = lazyImg;
                    }
                }
                
                // Only add if has essential data
                if (title && price && imageUrl && imageUrl.startsWith('http')) {
                    results.push({
                        id: String(index + 1),
                        platform: 'Amazon',
                        title: title,
                        price: price,
                        rating: rating,
                        reviewCount: reviewCount,
                        image: imageUrl,
                        productUrl: url
                    });
                }
            } catch (e) {
                console.error('Error extracting Amazon product:', e);
            }
        });
        
        console.log('Amazon: Extracted', results.length, 'products');
        return results;
    });
    
    return products;
}

// Flipkart Extractor - Enhanced
async function extractFlipkartProducts(page) {
    await scrollAndWait(page, 5);
    await page.waitForTimeout(6000);
    
    const products = await page.evaluate(() => {
        const results = [];
        
        // Try multiple container selectors
        let containers = document.querySelectorAll('[data-id]');
        if (containers.length === 0) {
            containers = document.querySelectorAll('._1AtVbE, ._13oc-S, .tUxRFH, ._1fQZEK, .DOjaWF, .CGtC98, ._75nlfW');
        }
        if (containers.length === 0) {
            containers = document.querySelectorAll('div[class*="product"], div[class*="item"]');
        }
        
        console.log('Flipkart: Found', containers.length, 'containers');
        
        containers.forEach((item, index) => {
            try {
                // Link
                let linkElement = item.querySelector('a[href*="/p/"]');
                if (!linkElement) linkElement = item.querySelector('a._1fQZEK, a.s1Q9rs, a._2rpwqI, a.wjcEIp, a.VJA3rP');
                if (!linkElement) linkElement = item.querySelector('a');
                if (!linkElement) return;
                
                // Title
                let titleElement = item.querySelector('.s1Q9rs, ._4rR01T, .IRpwTa, ._2WkVRV, .KzDlHZ, .wjcEIp');
                if (!titleElement) titleElement = item.querySelector('a[class*="title"]');
                if (!titleElement) titleElement = item.querySelector('div[class*="title"]');
                if (!titleElement) return;
                
                const title = titleElement.textContent.trim();
                const url = linkElement.href.startsWith('http') ? linkElement.href : 'https://www.flipkart.com' + linkElement.href;
                
                // Price
                let price = '';
                let priceElement = item.querySelector('._30jeq3, ._1_WHN1, ._3tbKJL, .Nx9bqj, ._4b5DiR');
                if (!priceElement) priceElement = item.querySelector('div[class*="price"]');
                if (priceElement) price = priceElement.textContent.trim();
                
                // Rating
                let rating = '';
                let ratingElement = item.querySelector('._3LWZlK, .XQDdHH, .Y1HWO0');
                if (!ratingElement) ratingElement = item.querySelector('div[class*="rating"]');
                if (ratingElement) rating = ratingElement.textContent.trim();
                
                // Reviews
                let reviewCount = '';
                let reviewElement = item.querySelector('._2_R_DZ span, ._13vcmD, .Wphh3N');
                if (!reviewElement) reviewElement = item.querySelector('span[class*="review"]');
                if (reviewElement) reviewCount = reviewElement.textContent.trim();
                
                // Image
                let imageUrl = '';
                const imgElement = item.querySelector('img');
                
                if (imgElement) {
                    imageUrl = imgElement.src || '';
                    
                    // Try data-src if src is not valid
                    if (!imageUrl || imageUrl.startsWith('data:') || imageUrl.includes('1x1')) {
                        imageUrl = imgElement.getAttribute('data-src') || '';
                    }
                    
                    // Try srcset
                    if (!imageUrl || imageUrl.startsWith('data:')) {
                        const srcset = imgElement.getAttribute('srcset');
                        if (srcset) {
                            const sources = srcset.split(',');
                            for (let src of sources) {
                                const url = src.trim().split(' ')[0];
                                if (url && url.startsWith('http')) {
                                    imageUrl = url;
                                    break;
                                }
                            }
                        }
                    }
                }
                
                if (title && price && imageUrl && imageUrl.startsWith('http')) {
                    results.push({
                        id: String(index + 1),
                        platform: 'Flipkart',
                        title: title,
                        price: price,
                        rating: rating,
                        reviewCount: reviewCount,
                        image: imageUrl,
                        productUrl: url
                    });
                }
            } catch (e) {
                console.error('Error extracting Flipkart product:', e);
            }
        });
        
        console.log('Flipkart: Extracted', results.length, 'products');
        return results;
    });
    
    return products;
}

// Meesho Extractor
async function extractMeeshoProducts(page) {
    await scrollAndWait(page, 4);
    
    const products = await page.evaluate(() => {
        const results = [];
        const containers = document.querySelectorAll('[class*="ProductCard"], [class*="product-card"], a[href*="/product/"], [class*="Card__"]');
        
        containers.forEach((item, index) => {
            try {
                const linkElement = item.tagName === 'A' ? item : item.querySelector('a[href*="/product/"]');
                if (!linkElement) return;
                
                const titleElement = item.querySelector('[class*="title"], [class*="name"], p, h3, h4, [class*="Text__"]');
                if (!titleElement) return;
                
                const title = titleElement.textContent.trim();
                const url = linkElement.href;
                
                const priceElement = item.querySelector('[class*="price"], [class*="Price"]');
                const price = priceElement ? priceElement.textContent.trim() : '';
                
                const ratingElement = item.querySelector('[class*="rating"], [class*="Rating"]');
                const rating = ratingElement ? ratingElement.textContent.trim() : '';
                
                const reviewElement = item.querySelector('[class*="review"], [class*="Review"]');
                const reviewCount = reviewElement ? reviewElement.textContent.trim() : '';
                
                const imgElement = item.querySelector('img');
                let imageUrl = '';
                
                if (imgElement) {
                    imageUrl = imgElement.src || imgElement.getAttribute('data-src') || '';
                }
                
                if (title && price && imageUrl && imageUrl.startsWith('http')) {
                    results.push({
                        id: String(index + 1),
                        platform: 'Meesho',
                        title: title,
                        price: price,
                        rating: rating,
                        reviewCount: reviewCount,
                        image: imageUrl,
                        productUrl: url
                    });
                }
            } catch (e) {
                console.error('Error extracting Meesho product:', e);
            }
        });
        
        return results;
    });
    
    return products;
}

// Myntra Extractor
async function extractMyntraProducts(page) {
    await scrollAndWait(page);
    
    const products = await page.evaluate(() => {
        const results = [];
        const containers = document.querySelectorAll('.product-base, li[class*="product"], .productCard');
        
        containers.forEach((item, index) => {
            try {
                const linkElement = item.querySelector('a');
                if (!linkElement) return;
                
                const titleElement = item.querySelector('.product-product, h3, h4, [class*="productName"], .product-brand, .product-productMetaInfo');
                if (!titleElement) return;
                
                const title = titleElement.textContent.trim();
                const url = linkElement.href.startsWith('http') ? linkElement.href : 'https://www.myntra.com' + linkElement.href;
                
                const priceElement = item.querySelector('.product-price, [class*="price"], .product-discountedPrice');
                const price = priceElement ? priceElement.textContent.trim() : '';
                
                const ratingElement = item.querySelector('.product-rating, [class*="rating"]');
                const rating = ratingElement ? ratingElement.textContent.trim() : '';
                
                const reviewElement = item.querySelector('[class*="count"], .product-ratingsCount');
                const reviewCount = reviewElement ? reviewElement.textContent.trim() : '';
                
                const imgElement = item.querySelector('img');
                let imageUrl = '';
                
                if (imgElement) {
                    imageUrl = imgElement.src || imgElement.getAttribute('data-src') || '';
                }
                
                if (title && price && imageUrl && imageUrl.startsWith('http')) {
                    results.push({
                        id: String(index + 1),
                        platform: 'Myntra',
                        title: title,
                        price: price,
                        rating: rating,
                        reviewCount: reviewCount,
                        image: imageUrl,
                        productUrl: url
                    });
                }
            } catch (e) {
                console.error('Error extracting Myntra product:', e);
            }
        });
        
        return results;
    });
    
    return products;
}

// Ajio Extractor
async function extractAjioProducts(page) {
    await scrollAndWait(page);
    
    const products = await page.evaluate(() => {
        const results = [];
        const containers = document.querySelectorAll('.item, [class*="product"], .rilrtl-products-list__item');
        
        containers.forEach((item, index) => {
            try {
                const linkElement = item.querySelector('a');
                if (!linkElement) return;
                
                const titleElement = item.querySelector('.nameCls, [class*="brand"], [class*="name"]');
                if (!titleElement) return;
                
                const title = titleElement.textContent.trim();
                const url = linkElement.href.startsWith('http') ? linkElement.href : 'https://www.ajio.com' + linkElement.href;
                
                const priceElement = item.querySelector('.price, [class*="price"]');
                const price = priceElement ? priceElement.textContent.trim() : '';
                
                const ratingElement = item.querySelector('[class*="rating"]');
                const rating = ratingElement ? ratingElement.textContent.trim() : '';
                
                const reviewElement = item.querySelector('[class*="count"]');
                const reviewCount = reviewElement ? reviewElement.textContent.trim() : '';
                
                const imgElement = item.querySelector('img');
                let imageUrl = '';
                
                if (imgElement) {
                    imageUrl = imgElement.src || imgElement.getAttribute('data-src') || '';
                }
                
                if (title && price && imageUrl && imageUrl.startsWith('http')) {
                    results.push({
                        id: String(index + 1),
                        platform: 'Ajio',
                        title: title,
                        price: price,
                        rating: rating,
                        reviewCount: reviewCount,
                        image: imageUrl,
                        productUrl: url
                    });
                }
            } catch (e) {
                console.error('Error extracting Ajio product:', e);
            }
        });
        
        return results;
    });
    
    return products;
}

// Croma Extractor
async function extractCromaProducts(page) {
    await scrollAndWait(page);
    
    const products = await page.evaluate(() => {
        const results = [];
        const containers = document.querySelectorAll('.product, [class*="product-item"], li.product');
        
        containers.forEach((item, index) => {
            try {
                const linkElement = item.querySelector('a.product-title, a[class*="product"]');
                if (!linkElement) return;
                
                const titleElement = item.querySelector('.product-title, [class*="title"], h3, h4');
                if (!titleElement) return;
                
                const title = titleElement.textContent.trim();
                const url = linkElement.href.startsWith('http') ? linkElement.href : 'https://www.croma.com' + linkElement.href;
                
                const priceElement = item.querySelector('.amount, .price, [class*="price"]');
                const price = priceElement ? priceElement.textContent.trim() : '';
                
                const ratingElement = item.querySelector('[class*="rating"]');
                const rating = ratingElement ? ratingElement.textContent.trim() : '';
                
                const reviewElement = item.querySelector('[class*="review"]');
                const reviewCount = reviewElement ? reviewElement.textContent.trim() : '';
                
                const imgElement = item.querySelector('img');
                let imageUrl = '';
                
                if (imgElement) {
                    imageUrl = imgElement.src || imgElement.getAttribute('data-src') || '';
                }
                
                if (title && price && imageUrl && imageUrl.startsWith('http')) {
                    results.push({
                        id: String(index + 1),
                        platform: 'Croma',
                        title: title,
                        price: price,
                        rating: rating,
                        reviewCount: reviewCount,
                        image: imageUrl,
                        productUrl: url
                    });
                }
            } catch (e) {
                console.error('Error extracting Croma product:', e);
            }
        });
        
        return results;
    });
    
    return products;
}

// Search functions for each platform
async function searchFlipkart(page, query) {
    try {
        const selector = 'input[name="q"], input[type="text"], input.Pke_EE';
        await page.waitForSelector(selector, { timeout: 10000 });
        await page.click(selector);
        await page.fill(selector, '');
        await page.fill(selector, query);
        await page.keyboard.press('Enter');
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(4000);
        return true;
    } catch (e) {
        console.log('⚠️  Flipkart search failed:', e.message);
        return false;
    }
}

async function searchMeesho(page, query) {
    try {
        const selector = 'input[type="text"], input[placeholder*="Search"], input[class*="SearchBar"]';
        await page.waitForSelector(selector, { timeout: 10000 });
        await page.click(selector);
        await page.fill(selector, '');
        await page.fill(selector, query);
        await page.keyboard.press('Enter');
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(4000);
        return true;
    } catch (e) {
        console.log('⚠️  Meesho search failed:', e.message);
        return false;
    }
}

async function searchMyntra(page, query) {
    try {
        const selector = 'input.desktop-searchBar, input[placeholder*="Search"]';
        await page.waitForSelector(selector, { timeout: 10000 });
        await page.click(selector);
        await page.fill(selector, '');
        await page.fill(selector, query);
        await page.keyboard.press('Enter');
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(4000);
        return true;
    } catch (e) {
        console.log('⚠️  Myntra search failed:', e.message);
        return false;
    }
}

async function searchAjio(page, query) {
    try {
        const selector = 'input[name="searchbar"], input[placeholder*="Search"]';
        await page.waitForSelector(selector, { timeout: 10000 });
        await page.click(selector);
        await page.fill(selector, '');
        await page.fill(selector, query);
        await page.keyboard.press('Enter');
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(4000);
        return true;
    } catch (e) {
        console.log('⚠️  Ajio search failed:', e.message);
        return false;
    }
}

async function searchCroma(page, query) {
    try {
        const selector = 'input[type="search"], input[placeholder*="Search"]';
        await page.waitForSelector(selector, { timeout: 10000 });
        await page.click(selector);
        await page.fill(selector, '');
        await page.fill(selector, query);
        await page.keyboard.press('Enter');
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(4000);
        return true;
    } catch (e) {
        console.log('⚠️  Croma search failed:', e.message);
        return false;
    }
}

// Platform-Specific Shopping Search
async function platformSpecificSearch(page, query, platform) {
    console.log(`🛍️  Platform-Specific Search: ${platform} - ${query}`);
    
    const platformMap = {
        'amazon': { 
            name: 'Amazon', 
            url: 'https://www.amazon.in', 
            searchFn: searchAmazon, 
            extractFn: extractAmazonProducts 
        },
        'flipkart': { 
            name: 'Flipkart', 
            url: 'https://www.flipkart.com', 
            searchFn: searchFlipkart, 
            extractFn: extractFlipkartProducts 
        },
        'meesho': { 
            name: 'Meesho', 
            url: 'https://www.meesho.com', 
            searchFn: searchMeesho, 
            extractFn: extractMeeshoProducts 
        },
        'myntra': { 
            name: 'Myntra', 
            url: 'https://www.myntra.com', 
            searchFn: searchMyntra, 
            extractFn: extractMyntraProducts 
        },
        'ajio': { 
            name: 'Ajio', 
            url: 'https://www.ajio.com', 
            searchFn: searchAjio, 
            extractFn: extractAjioProducts 
        },
        'croma': { 
            name: 'Croma', 
            url: 'https://www.croma.com', 
            searchFn: searchCroma, 
            extractFn: extractCromaProducts 
        }
    };
    
    const selectedPlatform = platformMap[platform.toLowerCase()];
    
    if (!selectedPlatform) {
        console.log(`⚠️  Unknown platform: ${platform}, using universal search`);
        return await universalShoppingSearch(page, query);
    }
    
    try {
        console.log(`🔍 Searching on ${selectedPlatform.name}...`);
        
        await page.goto(selectedPlatform.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForTimeout(2000);
        
        // Check for login/captcha
        const currentUrl = page.url();
        if (detectLoginPage(currentUrl, page)) {
            console.log(`⚠️  ${selectedPlatform.name} requires login or showing CAPTCHA`);
            return {
                products: [],
                warning: `${selectedPlatform.name} requires login or is blocking automation`
            };
        }
        
        const searchSuccess = await selectedPlatform.searchFn(page, query);
        if (!searchSuccess) {
            console.log(`⚠️  ${selectedPlatform.name} search failed`);
            return {
                products: [],
                warning: `Search failed on ${selectedPlatform.name}`
            };
        }
        
        const products = await selectedPlatform.extractFn(page);
        console.log(`✅ ${selectedPlatform.name}: Found ${products.length} products`);
        
        return {
            products: products.slice(0, 15), // Return up to 15 for single platform
            platformUsed: selectedPlatform.name
        };
        
    } catch (e) {
        console.log(`❌ ${selectedPlatform.name} error:`, e.message);
        return {
            products: [],
            error: `${selectedPlatform.name}: ${e.message}`
        };
    }
}

// Universal Shopping Aggregator with Smart Fallback
async function universalShoppingSearch(page, query) {
    console.log('🛍️  Universal Shopping Search:', query);
    
    let allProducts = [];
    const sources = [
        { name: 'Amazon', url: 'https://www.amazon.in', searchFn: searchAmazon, extractFn: extractAmazonProducts },
        { name: 'Flipkart', url: 'https://www.flipkart.com', searchFn: searchFlipkart, extractFn: extractFlipkartProducts },
        { name: 'Meesho', url: 'https://www.meesho.com', searchFn: searchMeesho, extractFn: extractMeeshoProducts },
        { name: 'Myntra', url: 'https://www.myntra.com', searchFn: searchMyntra, extractFn: extractMyntraProducts },
        { name: 'Ajio', url: 'https://www.ajio.com', searchFn: searchAjio, extractFn: extractAjioProducts },
        { name: 'Croma', url: 'https://www.croma.com', searchFn: searchCroma, extractFn: extractCromaProducts }
    ];
    
    for (const source of sources) {
        if (allProducts.length >= 10) break;
        
        try {
            console.log(`🔍 Trying ${source.name}...`);
            
            await page.goto(source.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
            await page.waitForTimeout(2000);
            
            // Check for login/captcha/robot check
            const currentUrl = page.url();
            if (detectLoginPage(currentUrl, page)) {
                console.log(`⚠️  ${source.name} requires login or showing CAPTCHA, skipping...`);
                continue;
            }
            
            const searchSuccess = await source.searchFn(page, query);
            if (!searchSuccess) {
                console.log(`⚠️  ${source.name} search failed, trying next...`);
                continue;
            }
            
            const products = await source.extractFn(page);
            console.log(`✅ ${source.name}: Found ${products.length} products`);
            
            if (products.length > 0) {
                allProducts = allProducts.concat(products);
            }
            
        } catch (e) {
            console.log(`❌ ${source.name} error: ${e.message}, trying next...`);
            continue;
        }
    }
    
    console.log(`🎯 Total products collected: ${allProducts.length}`);
    
    // Return up to 10 products
    return allProducts.slice(0, 10);
}

function convertToEmbedUrl(videoId) {
    return `https://www.youtube.com/embed/${videoId}`;
}

async function fetchYouTubeEmbeds(page, query) {
    try {
        await page.goto('https://www.youtube.com/results?search_query=' + encodeURIComponent(query), 
            { waitUntil: 'domcontentloaded', timeout: 30000 });
        
        await page.waitForTimeout(3000);
        
        const videos = await page.$$eval('ytd-video-renderer a#video-title, ytd-grid-video-renderer a#video-title', elements => 
            elements.slice(0, 5).map(el => ({
                title: el.textContent.trim(),
                url: 'https://www.youtube.com' + el.getAttribute('href'),
                videoId: el.getAttribute('href')?.split('v=')[1]?.split('&')[0]
            })).filter(v => v.videoId)
        ).catch(() => []);
        
        const embedVideos = videos.slice(0, 5).map(v => ({
            videoId: v.videoId,
            title: v.title,
            embedUrl: convertToEmbedUrl(v.videoId)
        }));
        
        while (embedVideos.length < 5) {
            embedVideos.push({
                videoId: '',
                title: 'No video available',
                embedUrl: ''
            });
        }
        
        return embedVideos.slice(0, 5);
    } catch (e) {
        console.log('⚠️  YouTube fetch failed:', e.message);
        return Array(5).fill({ videoId: '', title: 'Error loading video', embedUrl: '' });
    }
}

// ============================================
// WEB TASK AUTOMATION ENDPOINT
// ============================================
app.post('/api/web-task', async (req, res) => {
    let browser;
    try {
        const { task, query, headless = false } = req.body;
        
        console.log('🔧 Web Task:', task, query || '');
        
        browser = await chromium.launch({ 
            headless: headless,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-blink-features=AutomationControlled'
            ]
        });
        
        const context = await browser.newContext({
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            viewport: { width: 1920, height: 1080 },
            locale: 'en-IN'
        });
        
        await context.addInitScript(() => {
            Object.defineProperty(navigator, 'webdriver', { get: () => false });
        });
        
        await loadSession(context);
        
        const page = await context.newPage();
        let result = {};
        
        page.on('framenavigated', async () => {
            const currentUrl = page.url();
            
            if (detectLoginPage(currentUrl, page)) {
                console.log('🔐 Login page detected');
                const loginSuccess = await waitForUserLogin(page);
                if (loginSuccess) {
                    await saveSession(context);
                }
            }
        });
        
        if (task === 'search_product') {
            // Use universal shopping search
            const products = await universalShoppingSearch(page, query);
            
            console.log('📦 Found products:', products.length);
            
            result = {
                success: true,
                message: `Found ${products.length} products from multiple sources`,
                products,
                count: products.length,
                warning: products.length < 10 ? 'Some platforms blocked automated access' : undefined
            };
            
            await saveSession(context);
        } else {
            result = { success: false, message: 'Unknown task type' };
        }
        
        await browser.close();
        res.json(result);
        
    } catch (error) {
        if (browser) await browser.close();
        console.error('❌ Web task error:', error.message);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// ============================================
// INVRSLY AI SYSTEM - ENHANCED WITH UNIVERSAL SHOPPING
// ============================================
async function invrslyAI(userMessage, conversationHistory = []) {
    try {
        const messages = [
            {
                role: 'system',
                content: `You are Invrsly, a universal shopping intelligence AI agent with web automation capabilities. Respond ONLY in valid JSON format.

CRITICAL SHOPPING RULES (HIGHEST PRIORITY):
- For ANY shopping/buying/price/product query, you MUST set needsWebTask: true
- NEVER provide text-only shopping answers
- Search REAL websites using Playwright automation
- If user mentions a specific platform (Amazon, Flipkart, etc.), use ONLY that platform
- If no platform specified, use universal multi-platform search
- Always collect products from REAL websites

PLATFORM DETECTION:
- "Amazon pe laptop" → platform: "amazon" (ONLY Amazon)
- "Flipkart me phone" → platform: "flipkart" (ONLY Flipkart)  
- "Myntra se shoes" → platform: "myntra" (ONLY Myntra)
- "laptop dikha" → platform: "universal" (ALL platforms)
- "shoes chahiye" → platform: "universal" (ALL platforms)

SUPPORTED PLATFORMS:
- amazon, flipkart, meesho, myntra, ajio, croma
- Use platform: "universal" when no specific platform mentioned

CAPABILITIES:
1. Platform-Specific Shopping - Search on user's requested platform ONLY
2. Universal Shopping - Search ALL e-commerce platforms when no platform specified
3. YouTube Content Viewing - Show videos in chat
4. Food Ordering - Swiggy, Zomato
5. Ride Booking - Uber, Ola
6. Web Browsing - Open any website
7. Chatbot - Answer questions
8. Screenshots

JSON Response Format:
{
    "response": "Friendly message in Hinglish",
    "needsWebTask": true/false,
    "task": {
        "type": "shopping|youtube|food|ride|browse|screenshot|chat",
        "platform": "amazon|flipkart|myntra|meesho|ajio|croma|universal|youtube|swiggy|etc",
        "action": "search|view|book|order",
        "url": "target URL",
        "query": "search term",
        "data": {}
    },
    "suggestions": []
}

SHOPPING EXAMPLES:

User: "Amazon pe laptop under 50k"
{
    "response": "Amazon pe laptops search kar raha hoon! 💻",
    "needsWebTask": true,
    "task": {
        "type": "shopping",
        "platform": "amazon",
        "action": "search",
        "query": "laptop under 50000"
    }
}

User: "Flipkart me phone dikha"
{
    "response": "Flipkart pe phones dekh raha hoon! 📱",
    "needsWebTask": true,
    "task": {
        "type": "shopping",
        "platform": "flipkart",
        "action": "search",
        "query": "phone"
    }
}

User: "shoes dikha" (no platform specified)
{
    "response": "Sabhi platforms pe shoes search kar raha hoon! 👟",
    "needsWebTask": true,
    "task": {
        "type": "shopping",
        "platform": "universal",
        "action": "search",
        "query": "shoes"
    }
}

User: "Myntra se kurta"
{
    "response": "Myntra pe kurta dekh raha hoon! 👗",
    "needsWebTask": true,
    "task": {
        "type": "shopping",
        "platform": "myntra",
        "action": "search",
        "query": "kurta"
    }
}

User: "headphones under 2000"
{
    "response": "Best headphones search kar raha hoon! 🎧",
    "needsWebTask": true,
    "task": {
        "type": "shopping",
        "platform": "universal",
        "action": "search",
        "query": "headphones under 2000"
    }
}

OTHER FEATURES:

YOUTUBE:
User: "YouTube pe cooking videos"
{
    "response": "YouTube pe cooking videos search kar raha hoon! 🎥",
    "needsWebTask": true,
    "task": {
        "type": "youtube",
        "platform": "youtube",
        "action": "search",
        "query": "cooking videos"
    }
}

FOOD:
User: "pizza order karo"
{
    "response": "Swiggy pe pizza dekh raha hoon! 🍕",
    "needsWebTask": true,
    "task": {
        "type": "food",
        "platform": "swiggy",
        "action": "search",
        "query": "pizza"
    }
}

RIDE:
User: "cab book kar"
{
    "response": "Uber pe cab dekh raha hoon! 🚗",
    "needsWebTask": true,
    "task": {
        "type": "ride",
        "platform": "uber",
        "action": "book"
    }
}

BROWSE:
User: "Instagram khol"
{
    "response": "Instagram open kar raha hoon! 📱",
    "needsWebTask": true,
    "task": {
        "type": "browse",
        "platform": "instagram",
        "url": "https://www.instagram.com"
    }
}

CHAT:
User: "AI kya hai?"
{
    "response": "AI (Artificial Intelligence) ek technology hai jo machines ko intelligent banati hai! 🤖",
    "needsWebTask": false
}

STRICT RULES:
- ALWAYS return valid JSON
- For shopping: DETECT platform from user message
- If platform mentioned → use that platform ONLY
- If no platform → use "universal" for multi-platform search
- Be friendly, use Hinglish
- Use emojis
- Product URLs will open in browser`
            },
            ...conversationHistory,
            {
                role: 'user',
                content: userMessage
            }
        ];

        const response = await axios.post(
            OPENROUTER_API_URL,
            {
                model: 'openai/gpt-4o-mini',
                messages: messages,
                temperature: 0.7,
                max_tokens: 2000,
                response_format: { type: "json_object" }
            },
            {
                headers: {
                    'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
                    'Content-Type': 'application/json',
                    'HTTP-Referer': 'http://localhost:3000',
                    'X-Title': 'Invrsly AI Agent'
                }
            }
        );

        return response.data.choices[0].message.content;
    } catch (error) {
        console.error('AI Error:', error.response?.data || error.message);
        throw new Error('AI failed: ' + (error.response?.data?.error?.message || error.message));
    }
}

// ============================================
// ADVANCED AUTOMATION ENGINE
// ============================================
async function executeTask(task) {
    let browser;
    try {
        console.log('🚀 Task:', task.type, task.platform || '');
        
        browser = await chromium.launch({ 
            headless: false,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-blink-features=AutomationControlled'
            ]
        });
        
        const context = await browser.newContext({
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            viewport: { width: 1920, height: 1080 },
            locale: 'en-IN'
        });
        
        await context.addInitScript(() => {
            Object.defineProperty(navigator, 'webdriver', { get: () => false });
        });
        
        await loadSession(context);
        
        const page = await context.newPage();
        
        page.on('framenavigated', async () => {
            const currentUrl = page.url();
            
            if (detectLoginPage(currentUrl, page)) {
                console.log('🔐 Login page detected');
                const loginSuccess = await waitForUserLogin(page);
                if (loginSuccess) {
                    await saveSession(context);
                }
            }
        });
        
        let result = {};

        switch (task.type) {
            case 'youtube':
                const embedVideos = await fetchYouTubeEmbeds(page, task.query);
                
                result = {
                    type: 'youtube',
                    platform: 'YouTube',
                    videos: embedVideos,
                    count: embedVideos.length,
                    message: `Found ${embedVideos.filter(v => v.videoId).length} videos! 🎥`
                };
                break;

            case 'shopping':
                try {
                    let products = [];
                    let platformUsed = '';
                    let warning = undefined;
                    
                    // Check if specific platform requested
                    if (task.platform && task.platform !== 'universal') {
                        console.log(`🎯 Platform-specific search: ${task.platform}`);
                        const result = await platformSpecificSearch(page, task.query, task.platform);
                        products = result.products || [];
                        platformUsed = result.platformUsed || task.platform;
                        warning = result.warning || result.error;
                    } else {
                        // Universal multi-platform search
                        console.log('🌐 Universal multi-platform search');
                        products = await universalShoppingSearch(page, task.query);
                        platformUsed = 'Multiple Platforms';
                        if (products.length < 10) {
                            warning = 'Some platforms blocked automated access';
                        }
                    }
                    
                    console.log('📦 Total products collected:', products.length);
                    
                    result = {
                        type: 'shopping_results',
                        query: task.query,
                        sourceStrategy: task.platform === 'universal' ? 'universal_multi_platform' : 'platform_specific',
                        platform: platformUsed,
                        products: products,
                        count: products.length,
                        message: `Found ${products.length} products${platformUsed !== 'Multiple Platforms' ? ' on ' + platformUsed : ' from multiple sources'}! 🛍️`,
                        warning: warning
                    };
                } catch (e) {
                    console.log('⚠️  Shopping error:', e.message);
                    result = { 
                        type: 'shopping_results',
                        query: task.query,
                        error: 'Could not search products: ' + e.message, 
                        platform: task.platform || 'universal',
                        products: [],
                        warning: 'Search failed'
                    };
                }
                
                await saveSession(context);
                break;

            case 'food':
                const foodUrl = task.platform === 'zomato' ? 'https://www.zomato.com' : 'https://www.swiggy.com';
                await openSite(page, foodUrl);
                
                if (detectLoginPage(page.url(), page)) {
                    await waitForUserLogin(page);
                    await saveSession(context);
                }
                
                result = {
                    type: 'food',
                    platform: task.platform || 'swiggy',
                    message: `${task.platform || 'Swiggy'} opened in browser! 🍕`,
                    url: foodUrl
                };
                
                await saveSession(context);
                break;

            case 'ride':
                const rideUrl = task.platform === 'ola' ? 'https://www.olacabs.com' : 'https://www.uber.com/in/en/';
                await openSite(page, rideUrl);
                
                if (detectLoginPage(page.url(), page)) {
                    await waitForUserLogin(page);
                    await saveSession(context);
                }
                
                result = {
                    type: 'ride',
                    platform: task.platform || 'uber',
                    message: `${task.platform || 'Uber'} opened in browser! 🚗`,
                    url: rideUrl
                };
                
                await saveSession(context);
                break;

            case 'browse':
                let browseUrl = task.url;
                
                if (task.platform === 'instagram') browseUrl = 'https://www.instagram.com';
                if (task.platform === 'facebook') browseUrl = 'https://www.facebook.com';
                if (task.platform === 'twitter') browseUrl = 'https://www.twitter.com';
                if (task.platform === 'linkedin') browseUrl = 'https://www.linkedin.com';
                
                await openSite(page, browseUrl);
                
                if (detectLoginPage(page.url(), page)) {
                    await waitForUserLogin(page);
                    await saveSession(context);
                }
                
                const title = await page.title();
                
                result = {
                    type: 'browse',
                    platform: task.platform || 'web',
                    title: title,
                    url: browseUrl,
                    message: `Opened ${task.platform || 'website'} in browser! 🌐`
                };
                
                await saveSession(context);
                break;

            case 'screenshot':
                const url = task.url.startsWith('http') ? task.url : 'https://' + task.url;
                await openSite(page, url);
                
                if (detectLoginPage(page.url(), page)) {
                    await waitForUserLogin(page);
                    await saveSession(context);
                }
                
                const screenshotBuffer = await page.screenshot({ 
                    fullPage: task.data?.fullPage || false 
                });
                const base64Image = screenshotBuffer.toString('base64');
                
                result = { 
                    type: 'screenshot',
                    url: url,
                    message: 'Screenshot captured! 📸',
                    imageData: `data:image/png;base64,${base64Image}`,
                    title: await page.title()
                };
                
                await saveSession(context);
                break;

            default:
                result = { error: 'Unknown task type: ' + task.type };
        }

        await browser.close();
        console.log('✅ Task completed:', result.type);
        return result;
        
    } catch (error) {
        if (browser) await browser.close();
        console.error('❌ Task failed:', error.message);
        return { 
            error: 'Task failed: ' + error.message,
            type: task.type 
        };
    }
}

// ============================================
// API ENDPOINTS
// ============================================

app.post('/api/chat', async (req, res) => {
    try {
        const { message, history } = req.body;

        if (!message || message.trim() === '') {
            return res.status(400).json({ 
                success: false, 
                error: 'Message required' 
            });
        }

        console.log('💬 User:', message);

        const aiResponse = await invrslyAI(message, history || []);
        console.log('🤖 AI:', aiResponse.substring(0, 100) + '...');
        
        let parsedResponse;
        try {
            let jsonText = aiResponse;
            if (aiResponse.includes('```json')) {
                const match = aiResponse.match(/```json\n([\s\S]*?)\n```/);
                if (match) jsonText = match[1];
            } else if (aiResponse.includes('```')) {
                const match = aiResponse.match(/```\n([\s\S]*?)\n```/);
                if (match) jsonText = match[1];
            }
            
            parsedResponse = JSON.parse(jsonText);
        } catch (e) {
            parsedResponse = { 
                response: aiResponse,
                needsWebTask: false 
            };
        }

        if (parsedResponse.needsWebTask && parsedResponse.task) {
            console.log('🔧 Executing:', parsedResponse.task.type);
            const taskResult = await executeTask(parsedResponse.task);
            parsedResponse.taskResult = taskResult;
        }

        res.json({
            success: true,
            data: parsedResponse
        });

    } catch (error) {
        console.error('💥 Error:', error.message);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

app.get('/api/test', (req, res) => {
    res.json({ 
        success: true, 
        message: 'Invrsly AI Agent - Universal Shopping Intelligence! 🚀',
        timestamp: new Date().toISOString(),
        apiConfigured: OPENROUTER_API_KEY !== 'YOUR_API_KEY_HERE',
        features: [
            'Universal Shopping - ALL Platforms (Amazon, Flipkart, Meesho, Myntra, Ajio, Croma, etc.)',
            'Smart Fallback - Tries multiple sources until 10+ products found',
            'YouTube Video Viewing (5 Embeds)',
            'Real Product Images & Prices',
            'Multi-Platform Aggregation',
            'Product URLs - Click to redirect',
            'Food Ordering (Swiggy/Zomato)',
            'Ride Booking (Uber/Ola)',
            'Web Browsing',
            'Screenshots',
            'AI Chat',
            'Session Management',
            'Auto CAPTCHA/Login Detection'
        ]
    });
});

// ============================================
// START SERVER
// ============================================
app.listen(PORT, () => {
    console.log('\n' + '='.repeat(60));
    console.log('🚀 INVRSLY AI AGENT - UNIVERSAL SHOPPING INTELLIGENCE!');
    console.log('='.repeat(60));
    console.log(`📍 URL: http://localhost:${PORT}`);
    console.log(`🔑 API: ${OPENROUTER_API_KEY !== 'YOUR_API_KEY_HERE' ? '✅ OK' : '❌ NOT SET'}`);
    console.log('='.repeat(60));
    console.log('\n✨ Features:');
    console.log('   🛍️  Universal Shopping - ALL Platforms');
    console.log('   🔄 Smart Fallback - Multiple sources');
    console.log('   📦 Minimum 10 products guarantee');
    console.log('   🎥 YouTube - 5 embedded videos');
    console.log('   🔗 Click product → Redirect to site');
    console.log('   🍕 Food - Swiggy, Zomato');
    console.log('   🚗 Rides - Uber, Ola');
    console.log('   🌐 Browse - Any website');
    console.log('   📸 Screenshots - Capture pages');
    console.log('   💬 Chat - Answer questions');
    console.log('   💾 Session - Save/restore login');
    console.log('   🤖 Auto CAPTCHA detection\n');
});

process.on('unhandledRejection', (error) => {
    console.error('❌ Error:', error);

});



