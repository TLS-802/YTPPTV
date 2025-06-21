import path from 'path';
import express from 'express';
import axios from 'axios';
import cors from 'cors';
import { fileURLToPath } from 'url';
import fs from 'fs';
import crypto from 'crypto';
import dotenv from 'dotenv';
import { createRequire } from 'module';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);

// 导入共享的API站点配置
const API_SITES = require('./js/api-sites.js');

const config = {
  port: process.env.PORT || 8080,
  password: process.env.PASSWORD || '',
  corsOrigin: process.env.CORS_ORIGIN || '*',
  timeout: parseInt(process.env.REQUEST_TIMEOUT || '5000'),
  maxRetries: parseInt(process.env.MAX_RETRIES || '2'),
  cacheMaxAge: process.env.CACHE_MAX_AGE || '1d',
  userAgent: process.env.USER_AGENT || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
  debug: process.env.DEBUG === 'true'
};

const log = (...args) => {
  if (config.debug) {
    console.log('[DEBUG]', ...args);
  }
};

const app = express();

app.use(cors({
  origin: config.corsOrigin,
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  next();
});

function sha256Hash(input) {
  return new Promise((resolve) => {
    const hash = crypto.createHash('sha256');
    hash.update(input);
    resolve(hash.digest('hex'));
  });
}

async function renderPage(filePath, password) {
  let content = fs.readFileSync(filePath, 'utf8');
  if (password !== '') {
    const sha256 = await sha256Hash(password);
    content = content.replace('{{PASSWORD}}', sha256);
  }
  return content;
}

app.get(['/', '/index.html', '/player.html'], async (req, res) => {
  try {
    let filePath;
    switch (req.path) {
      case '/player.html':
        filePath = path.join(__dirname, 'player.html');
        break;
      default: // '/' 和 '/index.html'
        filePath = path.join(__dirname, 'index.html');
        break;
    }
    
    const content = await renderPage(filePath, config.password);
    res.send(content);
  } catch (error) {
    console.error('页面渲染错误:', error);
    res.status(500).send('读取静态页面失败');
  }
});

app.get('/s=:keyword', async (req, res) => {
  try {
    const filePath = path.join(__dirname, 'index.html');
    const content = await renderPage(filePath, config.password);
    res.send(content);
  } catch (error) {
    console.error('搜索页面渲染错误:', error);
    res.status(500).send('读取静态页面失败');
  }
});

function isValidUrl(urlString) {
  try {
    const parsed = new URL(urlString);
    const allowedProtocols = ['http:', 'https:'];
    
    // 从环境变量获取阻止的主机名列表
    const blockedHostnames = (process.env.BLOCKED_HOSTS || 'localhost,127.0.0.1,0.0.0.0,::1,internal,intranet,local').split(',');
    
    // 从环境变量获取阻止的 IP 前缀
    const blockedPrefixes = (process.env.BLOCKED_IP_PREFIXES || '192.168.,10.,172.16.,172.17.,172.18.,172.19.,172.20.,172.21.,172.22.,172.23.,172.24.,172.25.,172.26.,172.27.,172.28.,172.29.,172.30.,172.31.,169.254.').split(',');
    
    if (!allowedProtocols.includes(parsed.protocol)) {
      log('URL 协议不允许:', parsed.protocol);
      return false;
    }
    
    if (blockedHostnames.includes(parsed.hostname)) {
      log('主机名被阻止:', parsed.hostname);
      return false;
    }
    
    // 检查是否为私有或保留的IP地址
    for (const prefix of blockedPrefixes) {
      if (parsed.hostname.startsWith(prefix)) {
        log('IP前缀被阻止:', prefix);
        return false;
      }
    }
    
    // 检查是否为裸IP地址（不带域名的IP）
    const ipV4Regex = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
    if (ipV4Regex.test(parsed.hostname)) {
      // 进一步验证是否为私有IP
      const ipMatches = parsed.hostname.match(ipV4Regex);
      const ipParts = [
        parseInt(ipMatches[1], 10),
        parseInt(ipMatches[2], 10),
        parseInt(ipMatches[3], 10),
        parseInt(ipMatches[4], 10)
      ];
      
      // 检查常见的私有IP范围
      if (
        (ipParts[0] === 10) || // 10.0.0.0 - 10.255.255.255
        (ipParts[0] === 172 && ipParts[1] >= 16 && ipParts[1] <= 31) || // 172.16.0.0 - 172.31.255.255
        (ipParts[0] === 192 && ipParts[1] === 168) || // 192.168.0.0 - 192.168.255.255
        (ipParts[0] === 127) || // 127.0.0.0 - 127.255.255.255
        (ipParts[0] === 0) || // 0.0.0.0
        (ipParts[0] === 169 && ipParts[1] === 254) // 169.254.0.0 - 169.254.255.255 链接本地地址
      ) {
        log('私有IP被阻止:', parsed.hostname);
        return false;
      }
    }
    
    // 检查是否为localhost的别名
    if (/^(.+\.)?local(host)?(\..+)?$/.test(parsed.hostname)) {
      log('本地主机别名被阻止:', parsed.hostname);
      return false;
    }
    
    return true;
  } catch (error) {
    log('URL验证出错:', error.message);
    return false;
  }
}

// 代理请求处理
app.use('/proxy', async (req, res) => {
    try {
        const targetUrl = decodeURIComponent(req.url.substring(1));
        if (!targetUrl) {
            return res.status(400).json({ error: 'Missing target URL' });
        }

        if (!isValidUrl(targetUrl)) {
            return res.status(400).json({ error: 'Invalid target URL' });
        }

        // 添加请求头
        const headers = {
            'User-Agent': config.userAgent,
            'Accept': 'application/json, text/plain, */*',
            'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
            'Cache-Control': 'no-cache',
            'Pragma': 'no-cache',
            'Referer': 'https://www.douban.com/',
            'Origin': 'https://www.douban.com'
        };

        let retries = 0;
        let lastError = null;

        while (retries <= config.maxRetries) {
            try {
                // 设置超时
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), config.timeout);

                const response = await fetch(targetUrl, {
                    headers,
                    signal: controller.signal
                });

                clearTimeout(timeoutId);

                if (!response.ok) {
                    throw new Error(`HTTP error! status: ${response.status}`);
                }

                const contentType = response.headers.get('content-type');

                if (contentType && contentType.includes('application/json')) {
                    const data = await response.json();
                    return res.json(data);
                } else {
                    const text = await response.text();
                    return res.send(text);
                }
            } catch (error) {
                lastError = error;
                console.error(`Proxy attempt ${retries + 1} failed:`, error.message);
                retries++;
                
                if (retries <= config.maxRetries) {
                    // 等待一段时间后重试
                    await new Promise(resolve => setTimeout(resolve, 1000 * retries));
                    continue;
                }
                break;
            }
        }

        throw lastError || new Error('Request failed after retries');
    } catch (error) {
        console.error('Proxy error:', error.message);
        res.status(500).json({
            error: 'Proxy request failed',
            message: error.message
        });
    }
});

// 添加API路由处理
app.get('/api/search', async (req, res) => {
    try {
        const searchQuery = req.query.wd;
        const source = req.query.source || 'heimuer';
        const customApi = req.query.customApi || '';
        
        if (!searchQuery) {
            return res.status(400).json({ code: 400, msg: '缺少搜索参数' });
        }
        
        if (source === 'custom' && !customApi) {
            return res.status(400).json({ code: 400, msg: '使用自定义API时必须提供API地址' });
        }
        
        if (!API_SITES[source] && source !== 'custom') {
            return res.status(400).json({ code: 400, msg: '无效的API来源' });
        }
        
        // 构建API URL
        const apiUrl = source === 'custom'
            ? `${customApi}/?wd=${encodeURIComponent(searchQuery)}`
            : `${API_SITES[source].api}/?wd=${encodeURIComponent(searchQuery)}`;
        
        try {
            // 使用代理请求API
            const response = await fetch(apiUrl, {
                headers: {
                    'Accept': 'application/json',
                    'Cache-Control': 'no-cache',
                    'User-Agent': config.userAgent
                }
            });
            
            if (!response.ok) {
                throw new Error(`API请求失败: ${response.status}`);
            }
            
            const data = await response.json();
            
            // 检查JSON格式的有效性
            if (!data || !Array.isArray(data.list)) {
                throw new Error('API返回的数据格式无效');
            }
            
            // 添加源信息到每个结果
            data.list.forEach(item => {
                item.source_name = source === 'custom' ? '自定义源' : API_SITES[source].name;
                item.source_code = source;
                // 对于自定义源，添加API URL信息
                if (source === 'custom') {
                    item.api_url = customApi;
                }
            });
            
            return res.json({
                code: 200,
                list: data.list || [],
            });
        } catch (error) {
            console.error('API请求错误:', error.message);
            throw error;
        }
    } catch (error) {
        console.error('Search API Error:', error.message);
        res.status(500).json({
            code: 500,
            msg: `搜索失败: ${error.message}`
        });
    }
});

app.get('/api/detail', async (req, res) => {
    try {
        const id = req.query.id;
        const source = req.query.source || 'heimuer';
        const customApi = req.query.customApi || '';
        const customDetail = req.query.customDetail || '';
        
        if (!id) {
            return res.status(400).json({ code: 400, msg: '缺少视频ID参数' });
        }
        
        // 验证ID格式 - 只允许数字和有限的特殊字符
        if (!/^[\w-]+$/.test(id)) {
            return res.status(400).json({ code: 400, msg: '无效的视频ID格式' });
        }
        
        if (source === 'custom' && !customApi) {
            return res.status(400).json({ code: 400, msg: '使用自定义API时必须提供API地址' });
        }
        
        if (!API_SITES[source] && source !== 'custom') {
            return res.status(400).json({ code: 400, msg: '无效的API来源' });
        }
        
        // 构建API URL
        const apiUrl = source === 'custom'
            ? `${customApi}/?ac=detail&ids=${id}`
            : `${API_SITES[source].api}/?ac=detail&ids=${id}`;
        
        try {
            // 直接请求API
            const response = await fetch(apiUrl, {
                headers: {
                    'Accept': 'application/json',
                    'Cache-Control': 'no-cache',
                    'User-Agent': config.userAgent
                }
            });
            
            if (!response.ok) {
                throw new Error(`API请求失败: ${response.status}`);
            }
            
            const data = await response.json();
            
            // 检查返回的数据是否有效
            if (!data || !data.list || !Array.isArray(data.list) || data.list.length === 0) {
                throw new Error('获取到的详情内容无效');
            }
            
            // 获取第一个匹配的视频详情
            const videoDetail = data.list[0];
            
            // 提取播放地址
            let episodes = [];
            
            if (videoDetail.vod_play_url) {
                // 分割不同播放源
                const playSources = videoDetail.vod_play_url.split('$$$');
                
                // 提取第一个播放源的集数（通常为主要源）
                if (playSources.length > 0) {
                    const mainSource = playSources[0];
                    const episodeList = mainSource.split('#');
                    
                    // 从每个集数中提取URL
                    episodes = episodeList.map(ep => {
                        const parts = ep.split('$');
                        // 返回URL部分(通常是第二部分，如果有的话)
                        return parts.length > 1 ? parts[1] : '';
                    }).filter(url => url && (url.startsWith('http://') || url.startsWith('https://')));
                }
            }
            
            // 如果没有找到播放地址，尝试使用正则表达式查找m3u8链接
            const M3U8_PATTERN = /\$https?:\/\/[^"'\s]+?\.m3u8/g;
            if (episodes.length === 0 && videoDetail.vod_content) {
                const matches = videoDetail.vod_content.match(M3U8_PATTERN) || [];
                episodes = matches.map(link => link.replace(/^\$/, ''));
            }
            
            return res.json({
                code: 200,
                episodes: episodes,
                detailUrl: apiUrl,
                videoInfo: {
                    title: videoDetail.vod_name,
                    cover: videoDetail.vod_pic,
                    desc: videoDetail.vod_content,
                    type: videoDetail.type_name,
                    year: videoDetail.vod_year,
                    area: videoDetail.vod_area,
                    director: videoDetail.vod_director,
                    actor: videoDetail.vod_actor,
                    remarks: videoDetail.vod_remarks,
                    // 添加源信息
                    source_name: source === 'custom' ? '自定义源' : API_SITES[source].name,
                    source_code: source,
                    vod_id: id
                }
            });
        } catch (error) {
            console.error('API请求错误:', error);
            throw error;
        }
    } catch (error) {
        console.error('Detail API Error:', error);
        res.status(500).json({
            code: 500,
            msg: `获取详情失败: ${error.message}`
        });
    }
});

app.use(express.static(path.join(__dirname), {
  maxAge: config.cacheMaxAge
}));

app.use((err, req, res, next) => {
  console.error('服务器错误:', err);
  
  // 根据错误类型返回更具体的错误信息
  if (err.name === 'URIError') {
    return res.status(400).json({
      error: 'URL格式无效',
      message: '请检查请求URL是否正确',
      code: 'INVALID_URL'
    });
  } else if (err.code === 'ECONNREFUSED' || err.code === 'ECONNRESET') {
    return res.status(503).json({
      error: '无法连接到远程服务',
      message: '远程API暂时无法访问，请稍后重试',
      code: 'CONNECTION_ERROR'
    });
  } else if (err.code === 'ETIMEDOUT') {
    return res.status(504).json({
      error: '请求超时',
      message: '远程API响应超时，请稍后重试',
      code: 'TIMEOUT_ERROR'
    });
  }
  
  // 默认错误响应
  res.status(500).json({
    error: '服务器内部错误',
    message: config.debug ? err.message : '请稍后再试',
    code: 'INTERNAL_ERROR'
  });
});

app.use((req, res) => {
  res.status(404).send('页面未找到');
});

// 启动服务器
app.listen(config.port, () => {
  console.log(`服务器运行在 http://localhost:${config.port}`);
  if (config.password !== '') {
    console.log('登录密码已设置');
  }
  if (config.debug) {
    console.log('调试模式已启用');
    console.log('配置:', { ...config, password: config.password ? '******' : '' });
  }
});
