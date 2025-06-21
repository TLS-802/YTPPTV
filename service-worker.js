// 缓存名称和版本
const CACHE_NAME = 'ytpptv-cache-v1';
const DOUBAN_CACHE_NAME = 'ytpptv-douban-cache-v1';

// 需要缓存的资源列表
const urlsToCache = [
  '/',
  '/index.html',
  '/css/styles.css',
  '/css/index.css',
  '/js/main.js',
  '/js/api.js',
  '/js/douban.js',
  '/js/config.js',
  '/image/logo.png',
  '/libs/tailwindcss.min.js'
];

// 安装事件 - 预缓存静态资源
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => {
        return cache.addAll(urlsToCache);
      })
  );
});

// 激活事件 - 清理旧缓存
self.addEventListener('activate', event => {
  const cacheWhitelist = [CACHE_NAME, DOUBAN_CACHE_NAME];
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames.map(cacheName => {
          if (cacheWhitelist.indexOf(cacheName) === -1) {
            return caches.delete(cacheName);
          }
        })
      );
    })
  );
});

// 拦截请求事件
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  
  // 处理豆瓣API请求
  if (event.request.url.includes('/proxy/') && 
      decodeURIComponent(event.request.url).includes('movie.douban.com')) {
    event.respondWith(handleDoubanRequest(event.request));
    return;
  }
  
  // 处理常规静态资源请求
  event.respondWith(
    caches.match(event.request)
      .then(response => {
        // 如果找到缓存响应，则返回缓存
        if (response) {
          return response;
        }
        
        // 否则发起网络请求
        return fetch(event.request).then(
          response => {
            // 检查响应是否有效
            if(!response || response.status !== 200 || response.type !== 'basic') {
              return response;
            }
            
            // 克隆响应，因为响应是流，只能使用一次
            const responseToCache = response.clone();
            
            caches.open(CACHE_NAME)
              .then(cache => {
                // 将响应添加到缓存
                cache.put(event.request, responseToCache);
              });
              
            return response;
          }
        );
      })
  );
});

// 处理豆瓣API请求的特殊函数
async function handleDoubanRequest(request) {
  // 首先尝试从缓存获取
  const cachedResponse = await caches.match(request);
  if (cachedResponse) {
    // 检查缓存是否过期（1小时）
    const cachedData = await cachedResponse.json();
    const cacheTime = cachedData.cacheTime || 0;
    const now = Date.now();
    
    // 如果缓存未过期，直接返回
    if (now - cacheTime < 3600000) {
      return new Response(JSON.stringify(cachedData), {
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }
  
  // 缓存不存在或已过期，发起网络请求
  try {
    const response = await fetch(request);
    
    // 检查响应是否有效
    if (!response || !response.ok) {
      // 如果有缓存但已过期，仍然返回过期的缓存，好过没有
      if (cachedResponse) {
        return cachedResponse;
      }
      throw new Error('Network response was not ok');
    }
    
    // 克隆响应，因为响应是流，只能使用一次
    const responseToCache = response.clone();
    
    // 解析响应数据
    const data = await response.json();
    
    // 添加缓存时间戳
    data.cacheTime = Date.now();
    
    // 将响应添加到缓存
    const cache = await caches.open(DOUBAN_CACHE_NAME);
    await cache.put(request, new Response(JSON.stringify(data), {
      headers: { 'Content-Type': 'application/json' }
    }));
    
    // 返回带有缓存时间的响应
    return new Response(JSON.stringify(data), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error) {
    console.error('Fetching douban data failed:', error);
    
    // 如果网络请求失败但有缓存，返回缓存（即使已过期）
    if (cachedResponse) {
      return cachedResponse;
    }
    
    // 都失败了，返回错误响应
    return new Response(JSON.stringify({ error: 'Failed to fetch data' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}
