// 改进返回功能
function goBack(event) {
    // 防止默认链接行为
    if (event) event.preventDefault();
    
    // 1. 优先检查URL参数中的returnUrl
    const urlParams = new URLSearchParams(window.location.search);
    const returnUrl = urlParams.get('returnUrl');
    
    if (returnUrl) {
        // 如果URL中有returnUrl参数，优先使用
        window.location.href = decodeURIComponent(returnUrl);
        return;
    }
    
    // 2. 检查localStorage中保存的lastPageUrl
    const lastPageUrl = localStorage.getItem('lastPageUrl');
    if (lastPageUrl && lastPageUrl !== window.location.href) {
        window.location.href = lastPageUrl;
        return;
    }
    
    // 3. 检查是否是从搜索页面进入的播放器
    const referrer = document.referrer;
    
    // 检查 referrer 是否包含搜索参数
    if (referrer && (referrer.includes('/s=') || referrer.includes('?s='))) {
        // 如果是从搜索页面来的，返回到搜索页面
        window.location.href = referrer;
        return;
    }
    
    // 4. 如果是在iframe中打开的，尝试关闭iframe
    if (window.self !== window.top) {
        try {
            // 尝试调用父窗口的关闭播放器函数
            window.parent.closeVideoPlayer && window.parent.closeVideoPlayer();
            return;
        } catch (e) {
            console.error('调用父窗口closeVideoPlayer失败:', e);
        }
    }
    
    // 5. 无法确定上一页，则返回首页
    if (!referrer || referrer === '') {
        window.location.href = '/';
        return;
    }
    
    // 6. 以上都不满足，使用默认行为：返回上一页
    window.history.back();
}

// 页面加载时保存当前URL到localStorage，作为返回目标
window.addEventListener('load', function () {
    // 保存前一页面URL
    if (document.referrer && document.referrer !== window.location.href) {
        localStorage.setItem('lastPageUrl', document.referrer);
    }

    // 提取当前URL中的重要参数，以便在需要时能够恢复当前页面
    const urlParams = new URLSearchParams(window.location.search);
    const videoId = urlParams.get('id');
    const sourceCode = urlParams.get('source');

    if (videoId && sourceCode) {
        // 保存当前播放状态，以便其他页面可以返回
        localStorage.setItem('currentPlayingId', videoId);
        localStorage.setItem('currentPlayingSource', sourceCode);
    }
});


// =================================
// ============== PLAYER ==========
// =================================
// 全局变量
let currentVideoTitle = '';
let currentEpisodeIndex = 0;
let art = null; // 用于 ArtPlayer 实例
let currentHls = null; // 跟踪当前HLS实例
let currentEpisodes = [];
let episodesReversed = false;
let autoplayEnabled = true; // 默认开启自动连播
let videoHasEnded = false; // 跟踪视频是否已经自然结束
let userClickedPosition = null; // 记录用户点击的位置
let shortcutHintTimeout = null; // 用于控制快捷键提示显示时间
let adFilteringEnabled = true; // 默认开启广告过滤
let progressSaveInterval = null; // 定期保存进度的计时器
let currentVideoUrl = ''; // 记录当前实际的视频URL
const isWebkit = (typeof window.webkitConvertPointFromNodeToPage === 'function')
Artplayer.FULLSCREEN_WEB_IN_BODY = true;

// 页面加载
document.addEventListener('DOMContentLoaded', function () {
    // 移除密码验证检查，直接初始化页面内容
    initializePageContent();
});

// 初始化页面内容
function initializePageContent() {

    // 解析URL参数
    const urlParams = new URLSearchParams(window.location.search);
    let videoUrl = urlParams.get('url');
    const title = urlParams.get('title');
    const sourceCode = urlParams.get('source_code');
    let index = parseInt(urlParams.get('index') || '0');
    const episodesList = urlParams.get('episodes'); // 从URL获取集数信息
    const savedPosition = parseInt(urlParams.get('position') || '0'); // 获取保存的播放位置
    // 解决历史记录问题：检查URL是否是player.html开头的链接
    // 如果是，说明这是历史记录重定向，需要解析真实的视频URL
    if (videoUrl && videoUrl.includes('player.html')) {
        try {
            // 尝试从嵌套URL中提取真实的视频链接
            const nestedUrlParams = new URLSearchParams(videoUrl.split('?')[1]);
            // 从嵌套参数中获取真实视频URL
            const nestedVideoUrl = nestedUrlParams.get('url');
            // 检查嵌套URL是否包含播放位置信息
            const nestedPosition = nestedUrlParams.get('position');
            const nestedIndex = nestedUrlParams.get('index');
            const nestedTitle = nestedUrlParams.get('title');

            if (nestedVideoUrl) {
                videoUrl = nestedVideoUrl;

                // 更新当前URL参数
                const url = new URL(window.location.href);
                if (!urlParams.has('position') && nestedPosition) {
                    url.searchParams.set('position', nestedPosition);
                }
                if (!urlParams.has('index') && nestedIndex) {
                    url.searchParams.set('index', nestedIndex);
                }
                if (!urlParams.has('title') && nestedTitle) {
                    url.searchParams.set('title', nestedTitle);
                }
                // 替换当前URL
                window.history.replaceState({}, '', url);
            } else {
                showError('历史记录链接无效，请返回首页重新访问');
            }
        } catch (e) {
        }
    }

    // 保存当前视频URL
    currentVideoUrl = videoUrl || '';

    // 从localStorage获取数据
    currentVideoTitle = title || localStorage.getItem('currentVideoTitle') || '未知视频';
    currentEpisodeIndex = index;

    // 设置自动连播开关状态
    autoplayEnabled = localStorage.getItem('autoplayEnabled') !== 'false'; // 默认为true
    document.getElementById('autoplayToggle').checked = autoplayEnabled;

    // 获取广告过滤设置
    adFilteringEnabled = localStorage.getItem(PLAYER_CONFIG.adFilteringStorage) !== 'false'; // 默认为true

    // 监听自动连播开关变化
    document.getElementById('autoplayToggle').addEventListener('change', function (e) {
        autoplayEnabled = e.target.checked;
        localStorage.setItem('autoplayEnabled', autoplayEnabled);
    });

    // 优先使用URL传递的集数信息，否则从localStorage获取
    try {
        if (episodesList) {
            // 如果URL中有集数数据，优先使用它
            currentEpisodes = JSON.parse(decodeURIComponent(episodesList));

        } else {
            // 否则从localStorage获取
            currentEpisodes = JSON.parse(localStorage.getItem('currentEpisodes') || '[]');

        }

        // 检查集数索引是否有效，如果无效则调整为0
        if (index < 0 || (currentEpisodes.length > 0 && index >= currentEpisodes.length)) {
            // 如果索引太大，则使用最大有效索引
            if (index >= currentEpisodes.length && currentEpisodes.length > 0) {
                index = currentEpisodes.length - 1;
            } else {
                index = 0;
            }

            // 更新URL以反映修正后的索引
            const newUrl = new URL(window.location.href);
            newUrl.searchParams.set('index', index);
            window.history.replaceState({}, '', newUrl);
        }

        // 更新当前索引为验证过的值
        currentEpisodeIndex = index;

        episodesReversed = localStorage.getItem('episodesReversed') === 'true';
    } catch (e) {
        currentEpisodes = [];
        currentEpisodeIndex = 0;
        episodesReversed = false;
    }

    // 设置页面标题
    document.title = currentVideoTitle + ' - YTPPTV播放器';
    document.getElementById('videoTitle').textContent = currentVideoTitle;

    // 初始化播放器
    if (videoUrl) {
        initPlayer(videoUrl);
    } else {
        showError('无效的视频链接');
    }

    // 更新集数信息
    updateEpisodeInfo();

    // 渲染集数列表
    renderEpisodes();

    // 初始渲染资源信息卡片
    renderResourceInfoBar();

    // 更新按钮状态
    updateButtonStates();

    // 更新排序按钮状态
    updateOrderButton();

    // 添加对进度条的监听，确保点击准确跳转
    setTimeout(() => {
        setupProgressBarPreciseClicks();
    }, 1000);

    // 添加键盘快捷键事件监听
    document.addEventListener('keydown', handleKeyboardShortcuts);

    // 添加页面离开事件监听，保存播放位置
    window.addEventListener('beforeunload', saveCurrentProgress);

    // 新增：页面隐藏（切后台/切标签）时也保存
    document.addEventListener('visibilitychange', function () {
        if (document.visibilityState === 'hidden') {
            saveCurrentProgress();
        }
    });

    // 视频暂停时也保存
    const waitForVideo = setInterval(() => {
        if (art && art.video) {
            art.video.addEventListener('pause', saveCurrentProgress);

            // 新增：播放进度变化时节流保存
            clearInterval(waitForVideo);
        }
    }, 500);

    // 新增：启动定期保存进度的计时器
    startProgressSaveInterval();
    
    // 确保资源信息卡片正确显示 - 多次尝试渲染
    setTimeout(renderResourceInfoBar, 500);
    setTimeout(renderResourceInfoBar, 1500);
    setTimeout(renderResourceInfoBar, 3000);
    
    // 监听API_SITES的加载状态
    const checkApiSites = setInterval(() => {
        if (typeof API_SITES !== 'undefined' && API_SITES) {
            console.log('检测到API_SITES已加载，重新渲染资源信息');
            renderResourceInfoBar();
            clearInterval(checkApiSites);
        }
    }, 1000);
}

// 处理键盘快捷键
function handleKeyboardShortcuts(e) {
    // 忽略输入框中的按键事件
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

    // Alt + 左箭头 = 上一集
    if (e.altKey && e.key === 'ArrowLeft') {
        if (currentEpisodeIndex > 0) {
            playPreviousEpisode();
            showShortcutHint('上一集', 'left');
            e.preventDefault();
        }
    }

    // Alt + 右箭头 = 下一集
    if (e.altKey && e.key === 'ArrowRight') {
        if (currentEpisodeIndex < currentEpisodes.length - 1) {
            playNextEpisode();
            showShortcutHint('下一集', 'right');
            e.preventDefault();
        }
    }

    // 左箭头 = 快退
    if (!e.altKey && e.key === 'ArrowLeft') {
        if (art && art.currentTime > 5) {
            art.currentTime -= 5;
            showShortcutHint('快退', 'left');
            e.preventDefault();
        }
    }

    // 右箭头 = 快进
    if (!e.altKey && e.key === 'ArrowRight') {
        if (art && art.currentTime < art.duration - 5) {
            art.currentTime += 5;
            showShortcutHint('快进', 'right');
            e.preventDefault();
        }
    }

    // 上箭头 = 音量+
    if (e.key === 'ArrowUp') {
        if (art && art.volume < 1) {
            art.volume += 0.1;
            showShortcutHint('音量+', 'up');
            e.preventDefault();
        }
    }

    // 下箭头 = 音量-
    if (e.key === 'ArrowDown') {
        if (art && art.volume > 0) {
            art.volume -= 0.1;
            showShortcutHint('音量-', 'down');
            e.preventDefault();
        }
    }

    // 空格 = 播放/暂停
    if (e.key === ' ') {
        if (art) {
            art.toggle();
            showShortcutHint('播放/暂停', 'play');
            e.preventDefault();
        }
    }

    // f 键 = 切换全屏
    if (e.key === 'f' || e.key === 'F') {
        if (art) {
            art.fullscreen = !art.fullscreen;
            showShortcutHint('切换全屏', 'fullscreen');
            e.preventDefault();
        }
    }
}

// 显示快捷键提示
function showShortcutHint(text, direction) {
    const hintElement = document.getElementById('shortcutHint');
    const textElement = document.getElementById('shortcutText');
    const iconElement = document.getElementById('shortcutIcon');

    // 清除之前的超时
    if (shortcutHintTimeout) {
        clearTimeout(shortcutHintTimeout);
    }

    // 设置文本和图标方向
    textElement.textContent = text;

    if (direction === 'left') {
        iconElement.innerHTML = '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7"></path>';
    } else if (direction === 'right') {
        iconElement.innerHTML = '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"></path>';
    }  else if (direction === 'up') {
        iconElement.innerHTML = '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 15l7-7 7 7"></path>';
    } else if (direction === 'down') {
        iconElement.innerHTML = '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"></path>';
    } else if (direction === 'fullscreen') {
        iconElement.innerHTML = '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5v-4m0 4h-4m4 0l-5-5"></path>';
    } else if (direction === 'play') {
        iconElement.innerHTML = '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 3l14 9-14 9V3z"></path>';
    }

    // 显示提示
    hintElement.classList.add('show');

    // 两秒后隐藏
    shortcutHintTimeout = setTimeout(() => {
        hintElement.classList.remove('show');
    }, 2000);
}

// 初始化播放器
function initPlayer(videoUrl) {
    if (!videoUrl) {
        return
    }

    // 销毁旧实例
    if (art) {
        art.destroy();
        art = null;
    }

    // 配置HLS.js选项
    const hlsConfig = {
        debug: false,
        loader: adFilteringEnabled ? CustomHlsJsLoader : Hls.DefaultConfig.loader,
        enableWorker: true,
        lowLatencyMode: false,
        backBufferLength: 90,
        maxBufferLength: 30,
        maxMaxBufferLength: 60,
        maxBufferSize: 30 * 1000 * 1000,
        maxBufferHole: 0.5,
        fragLoadingMaxRetry: 6,
        fragLoadingMaxRetryTimeout: 64000,
        fragLoadingRetryDelay: 1000,
        manifestLoadingMaxRetry: 3,
        manifestLoadingRetryDelay: 1000,
        levelLoadingMaxRetry: 4,
        levelLoadingRetryDelay: 1000,
        startLevel: -1,
        abrEwmaDefaultEstimate: 500000,
        abrBandWidthFactor: 0.95,
        abrBandWidthUpFactor: 0.7,
        abrMaxWithRealBitrate: true,
        stretchShortVideoTrack: true,
        appendErrorMaxRetry: 5,  // 增加尝试次数
        liveSyncDurationCount: 3,
        liveDurationInfinity: false
    };

    // Create new ArtPlayer instance
    art = new Artplayer({
        container: '#player',
        url: videoUrl,
        type: 'm3u8',
        title: videoTitle,
        volume: 0.8,
        isLive: false,
        muted: false,
        autoplay: true,
        pip: false,
        autoSize: false,
        autoMini: false,
        screenshot: true,
        setting: true,
        loop: false,
        flip: false,
        playbackRate: true,
        aspectRatio: false,
        fullscreen: true,
        fullscreenWeb: true,
        subtitleOffset: false,
        miniProgressBar: true,
        mutex: true,
        backdrop: true,
        playsInline: true,
        autoPlayback: false,
        airplay: true,
        hotkey: false,
        theme: '#23ade5',
        lang: navigator.language.toLowerCase(),
        moreVideoAttr: {
            crossOrigin: 'anonymous',
        },
        customType: {
            m3u8: function (video, url) {
                // 清理之前的HLS实例
                if (currentHls && currentHls.destroy) {
                    try {
                        currentHls.destroy();
                    } catch (e) {
                    }
                }

                // 创建新的HLS实例
                const hls = new Hls(hlsConfig);
                currentHls = hls;

                // 跟踪是否已经显示错误
                let errorDisplayed = false;
                // 跟踪是否有错误发生
                let errorCount = 0;
                // 跟踪视频是否开始播放
                let playbackStarted = false;
                // 跟踪视频是否出现bufferAppendError
                let bufferAppendErrorCount = 0;

                // 监听视频播放事件
                video.addEventListener('playing', function () {
                    playbackStarted = true;
                    document.getElementById('loading').style.display = 'none';
                    document.getElementById('error').style.display = 'none';
                });

                // 监听视频进度事件
                video.addEventListener('timeupdate', function () {
                    if (video.currentTime > 1) {
                        // 视频进度超过1秒，隐藏错误（如果存在）
                        document.getElementById('error').style.display = 'none';
                    }
                });

                hls.loadSource(url);
                hls.attachMedia(video);

                // enable airplay, from https://github.com/video-dev/hls.js/issues/5989
                // 检查是否已存在source元素，如果存在则更新，不存在则创建
                let sourceElement = video.querySelector('source');
                if (sourceElement) {
                    // 更新现有source元素的URL
                    sourceElement.src = videoUrl;
                } else {
                    // 创建新的source元素
                    sourceElement = document.createElement('source');
                    sourceElement.src = videoUrl;
                    video.appendChild(sourceElement);
                }
                video.disableRemotePlayback = false;

                hls.on(Hls.Events.MANIFEST_PARSED, function () {
                    video.play().catch(e => {
                    });
                });

                hls.on(Hls.Events.ERROR, function (event, data) {
                    // 增加错误计数
                    errorCount++;

                    // 处理bufferAppendError
                    if (data.details === 'bufferAppendError') {
                        bufferAppendErrorCount++;
                        // 如果视频已经开始播放，则忽略这个错误
                        if (playbackStarted) {
                            return;
                        }

                        // 如果出现多次bufferAppendError但视频未播放，尝试恢复
                        if (bufferAppendErrorCount >= 3) {
                            hls.recoverMediaError();
                        }
                    }

                    // 如果是致命错误，且视频未播放
                    if (data.fatal && !playbackStarted) {
                        // 尝试恢复错误
                        switch (data.type) {
                            case Hls.ErrorTypes.NETWORK_ERROR:
                                hls.startLoad();
                                break;
                            case Hls.ErrorTypes.MEDIA_ERROR:
                                hls.recoverMediaError();
                                break;
                            default:
                                // 仅在多次恢复尝试后显示错误
                                if (errorCount > 3 && !errorDisplayed) {
                                    errorDisplayed = true;
                                    showError('视频加载失败，可能是格式不兼容或源不可用');
                                }
                                break;
                        }
                    }
                });

                // 监听分段加载事件
                hls.on(Hls.Events.FRAG_LOADED, function () {
                    document.getElementById('loading').style.display = 'none';
                });

                // 监听级别加载事件
                hls.on(Hls.Events.LEVEL_LOADED, function () {
                    document.getElementById('loading').style.display = 'none';
                });
            }
        }
    });

    // 自动隐藏工具栏的逻辑
    let hideTimer;
    const HIDE_DELAY = 2000; // 2秒后隐藏

    // 创建鼠标跟踪状态
    let isMouseActive = false;
    let isMouseOverPlayer = false;

    function hideControls() {
        if (isMouseActive || !isMouseOverPlayer) return;
        art.controls.classList.add('art-controls-hide');
    }

    function showControls() {
        art.controls.classList.remove('art-controls-hide');
    }

    function resetHideTimer() {
        clearTimeout(hideTimer);
        showControls();
        isMouseActive = true;

        hideTimer = setTimeout(() => {
            isMouseActive = false;
            hideControls();
        }, HIDE_DELAY);
    }

    // 监听全屏状态变化
    art.on('fullscreenWeb:enter', () => {
        // 添加全局事件监听
        document.addEventListener('mousemove', resetHideTimer);
        document.addEventListener('mouseleave', handleMouseLeave);
        document.addEventListener('mouseenter', handleMouseEnter);

        // 添加播放器区域事件
        art.player.addEventListener('mouseenter', () => isMouseOverPlayer = true);
        art.player.addEventListener('mouseleave', () => isMouseOverPlayer = false);

        // 初始状态
        isMouseOverPlayer = true;
        resetHideTimer();
    });

    art.on('fullscreenWeb:exit', () => {
        // 移除所有事件监听
        document.removeEventListener('mousemove', resetHideTimer);
        document.removeEventListener('mouseleave', handleMouseLeave);
        document.removeEventListener('mouseenter', handleMouseEnter);

        art.player.removeEventListener('mouseenter', () => isMouseOverPlayer = true);
        art.player.removeEventListener('mouseleave', () => isMouseOverPlayer = false);

        // 清除定时器并显示控件
        clearTimeout(hideTimer);
        showControls();
    });

    // 处理鼠标离开浏览器窗口
    function handleMouseLeave() {
        // 立即隐藏工具栏
        hideControls();
        clearTimeout(hideTimer);
    }
    
    // 处理鼠标返回浏览器窗口
    function handleMouseEnter() {
        isMouseActive = true;
        resetHideTimer();
    }

    // 播放器加载完成后初始隐藏工具栏
    art.on('ready', () => {
        art.controls.classList.add('art-controls-hide');
    });

    // 全屏模式处理
    art.on('fullscreen', function () {
        if (window.screen.orientation && window.screen.orientation.lock) {
            window.screen.orientation.lock('landscape')
                .then(() => {
                })
                .catch((error) => {
                });
        }
    });

    art.on('video:loadedmetadata', function() {
        document.getElementById('loading').style.display = 'none';
        videoHasEnded = false; // 视频加载时重置结束标志
        // 优先使用URL传递的position参数
        const urlParams = new URLSearchParams(window.location.search);
        const savedPosition = parseInt(urlParams.get('position') || '0');

        if (savedPosition > 10 && savedPosition < art.duration - 2) {
            // 如果URL中有有效的播放位置参数，直接使用它
            art.currentTime = savedPosition;
            showPositionRestoreHint(savedPosition);
        } else {
            // 否则尝试从本地存储恢复播放进度
            try {
                const progressKey = 'videoProgress_' + getVideoId();
                const progressStr = localStorage.getItem(progressKey);
                if (progressStr && art.duration > 0) {
                    const progress = JSON.parse(progressStr);
                    if (
                        progress &&
                        typeof progress.position === 'number' &&
                        progress.position > 10 &&
                        progress.position < art.duration - 2
                    ) {
                        art.currentTime = progress.position;
                        showPositionRestoreHint(progress.position);
                    }
                }
            } catch (e) {
            }
        }

        // 设置进度条点击监听
        setupProgressBarPreciseClicks();

        // 视频加载成功后，在稍微延迟后将其添加到观看历史
        setTimeout(saveToHistory, 3000);

        // 启动定期保存播放进度
        startProgressSaveInterval();
    })

    // 错误处理
    art.on('video:error', function (error) {
        // 如果正在切换视频，忽略错误
        if (window.isSwitchingVideo) {
            return;
        }

        // 隐藏所有加载指示器
        const loadingElements = document.querySelectorAll('#loading, .player-loading-container');
        loadingElements.forEach(el => {
            if (el) el.style.display = 'none';
        });

        showError('视频播放失败: ' + (error.message || '未知错误'));
    });

    // 添加移动端长按三倍速播放功能
    setupLongPressSpeedControl();

    // 视频播放结束事件
    art.on('video:ended', function () {
        videoHasEnded = true;

        clearVideoProgress();

        // 如果自动播放下一集开启，且确实有下一集
        if (autoplayEnabled && currentEpisodeIndex < currentEpisodes.length - 1) {
            // 稍长延迟以确保所有事件处理完成
            setTimeout(() => {
                // 确认不是因为用户拖拽导致的假结束事件
                playNextEpisode();
                videoHasEnded = false; // 重置标志
            }, 1000);
        } else {
            art.fullscreen = false;
        }
    });

    // 添加双击全屏支持
    art.on('video:playing', () => {
        // 绑定双击事件到视频容器
        if (art.video) {
            art.video.addEventListener('dblclick', () => {
                art.fullscreen = !art.fullscreen;
                art.play();
            });
        }
    });

    // 10秒后如果仍在加载，但不立即显示错误
    setTimeout(function () {
        // 如果视频已经播放开始，则不显示错误
        if (art && art.video && art.video.currentTime > 0) {
            return;
        }

        const loadingElement = document.getElementById('loading');
        if (loadingElement && loadingElement.style.display !== 'none') {
            loadingElement.innerHTML = `
                <div class="loading-spinner"></div>
                <div>视频加载时间较长，请耐心等待...</div>
                <div style="font-size: 12px; color: #aaa; margin-top: 10px;">如长时间无响应，请尝试其他视频源</div>
            `;
        }
    }, 10000);
}

// 自定义M3U8 Loader用于过滤广告
class CustomHlsJsLoader extends Hls.DefaultConfig.loader {
    constructor(config) {
        super(config);
        const load = this.load.bind(this);
        this.load = function (context, config, callbacks) {
            // 拦截manifest和level请求
            if (context.type === 'manifest' || context.type === 'level') {
                const onSuccess = callbacks.onSuccess;
                callbacks.onSuccess = function (response, stats, context) {
                    // 如果是m3u8文件，处理内容以移除广告分段
                    if (response.data && typeof response.data === 'string') {
                        // 过滤掉广告段 - 实现更精确的广告过滤逻辑
                        response.data = filterAdsFromM3U8(response.data, true);
                    }
                    return onSuccess(response, stats, context);
                };
            }
            // 执行原始load方法
            load(context, config, callbacks);
        };
    }
}

// 过滤可疑的广告内容
function filterAdsFromM3U8(m3u8Content, strictMode = false) {
    if (!m3u8Content) return '';

    // 按行分割M3U8内容
    const lines = m3u8Content.split('\n');
    const filteredLines = [];

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        // 只过滤#EXT-X-DISCONTINUITY标识
        if (!line.includes('#EXT-X-DISCONTINUITY')) {
            filteredLines.push(line);
        }
    }

    return filteredLines.join('\n');
}


// 显示错误
function showError(message) {
    // 在视频已经播放的情况下不显示错误
    if (art && art.video && art.video.currentTime > 1) {
        return;
    }
    const loadingEl = document.getElementById('loading');
    if (loadingEl) loadingEl.style.display = 'none';
    const errorEl = document.getElementById('error');
    if (errorEl) errorEl.style.display = 'flex';
    const errorMsgEl = document.getElementById('error-message');
    if (errorMsgEl) errorMsgEl.textContent = message;
}

// 更新集数信息
function updateEpisodeInfo() {
    if (currentEpisodes.length > 0) {
        document.getElementById('episodeInfo').textContent = `第 ${currentEpisodeIndex + 1}/${currentEpisodes.length} 集`;
    } else {
        document.getElementById('episodeInfo').textContent = '无集数信息';
    }
}

// 更新按钮状态
function updateButtonStates() {
    const prevButton = document.getElementById('prevButton');
    const nextButton = document.getElementById('nextButton');

    // 处理上一集按钮
    if (currentEpisodeIndex > 0) {
        prevButton.classList.remove('bg-gray-700', 'cursor-not-allowed');
        prevButton.classList.add('bg-[#222]', 'hover:bg-[#333]');
        prevButton.removeAttribute('disabled');
    } else {
        prevButton.classList.add('bg-gray-700', 'cursor-not-allowed');
        prevButton.classList.remove('bg-[#222]', 'hover:bg-[#333]');
        prevButton.setAttribute('disabled', '');
    }

    // 处理下一集按钮
    if (currentEpisodeIndex < currentEpisodes.length - 1) {
        nextButton.classList.remove('bg-gray-700', 'cursor-not-allowed');
        nextButton.classList.add('bg-[#222]', 'hover:bg-[#333]');
        nextButton.removeAttribute('disabled');
    } else {
        nextButton.classList.add('bg-gray-700', 'cursor-not-allowed');
        nextButton.classList.remove('bg-[#222]', 'hover:bg-[#333]');
        nextButton.setAttribute('disabled', '');
    }
}

// 渲染集数按钮
function renderEpisodes() {
    const episodesList = document.getElementById('episodesList');
    if (!episodesList) return;

    if (!currentEpisodes || currentEpisodes.length === 0) {
        episodesList.innerHTML = '<div class="col-span-full text-center text-gray-400 py-8">没有可用的集数</div>';
        return;
    }

    const episodes = episodesReversed ? [...currentEpisodes].reverse() : currentEpisodes;
    let html = '';

    episodes.forEach((episode, index) => {
        // 根据倒序状态计算真实的剧集索引
        const realIndex = episodesReversed ? currentEpisodes.length - 1 - index : index;
        const isActive = realIndex === currentEpisodeIndex;

        html += `
            <button id="episode-${realIndex}" 
                    onclick="playEpisode(${realIndex})" 
                    class="px-4 py-2 ${isActive ? 'episode-active bg-blue-600 text-white' : '!bg-[#222] hover:!bg-[#333] hover:!shadow-none'} !border ${isActive ? '!border-blue-500' : '!border-[#333]'} rounded-lg transition-colors text-center episode-btn">
                ${realIndex + 1}
            </button>
        `;
    });

    episodesList.innerHTML = html;
}

// 播放指定集数
function playEpisode(index) {
    // 确保index在有效范围内
    if (index < 0 || index >= currentEpisodes.length) {
        return;
    }

    // 保存当前播放进度（如果正在播放）
    if (art && art.video && !art.video.paused && !videoHasEnded) {
        saveCurrentProgress();
    }

    // 清除进度保存计时器
    if (progressSaveInterval) {
        clearInterval(progressSaveInterval);
        progressSaveInterval = null;
    }

    // 首先隐藏之前可能显示的错误
    document.getElementById('error').style.display = 'none';
    // 显示加载指示器
    document.getElementById('loading').style.display = 'flex';
    document.getElementById('loading').innerHTML = `
        <div class="loading-spinner"></div>
        <div>正在加载视频...</div>
    `;

    // 获取 sourceCode
    const urlParams2 = new URLSearchParams(window.location.search);
    const sourceCode = urlParams2.get('source_code');

    // 准备切换剧集的URL
    const url = currentEpisodes[index];

    // 更新当前剧集索引
    currentEpisodeIndex = index;
    currentVideoUrl = url;
    videoHasEnded = false; // 重置视频结束标志

    clearVideoProgress();

    // 更新URL参数（不刷新页面）
    const currentUrl = new URL(window.location.href);
    currentUrl.searchParams.set('index', index);
    currentUrl.searchParams.set('url', url);
    currentUrl.searchParams.delete('position');
    window.history.replaceState({}, '', currentUrl.toString());

    if (isWebkit) {
        initPlayer(url);
    } else {
        art.switch = url;
    }

    // 更新UI
    updateEpisodeInfo();
    updateButtonStates();
    renderEpisodes();

    // 重置用户点击位置记录
    userClickedPosition = null;

    // 三秒后保存到历史记录
    setTimeout(() => saveToHistory(), 3000);

    // 自动跳转到对应集数的URL
    const urlParams = new URLSearchParams(window.location.search);
    const title = urlParams.get('title') || '';
    if (url) {
        window.location.href = `player.html?url=${encodeURIComponent(url)}&title=${encodeURIComponent(title)}&source_code=${sourceCode}&index=${index}`;
    }
}

// 播放上一集
function playPreviousEpisode() {
    if (currentEpisodeIndex > 0) {
        playEpisode(currentEpisodeIndex - 1);
    }
}

// 播放下一集
function playNextEpisode() {
    if (currentEpisodeIndex < currentEpisodes.length - 1) {
        playEpisode(currentEpisodeIndex + 1);
    }
}

// 复制播放链接
function copyLinks() {
    // 尝试从URL中获取参数
    const urlParams = new URLSearchParams(window.location.search);
    const linkUrl = urlParams.get('url') || '';
    if (linkUrl !== '') {
        navigator.clipboard.writeText(linkUrl).then(() => {
            showToast('播放链接已复制', 'success');
        }).catch(err => {
            showToast('复制失败，请检查浏览器权限', 'error');
        });
    }
}

// 切换集数排序
function toggleEpisodeOrder() {
    window.episodesReversed = !window.episodesReversed;
    
    // 保存到localStorage
    localStorage.setItem('episodesReversed', window.episodesReversed);
    
    // 重新渲染集数列表
    renderEpisodeCards();
    
    // 更新排序按钮
    const toggleBtn = document.querySelector('.episode-order-btn');
    if (toggleBtn) {
        toggleBtn.innerHTML = window.episodesReversed ? 
            '<span>正序排列</span><svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M10 4v12m0 0l-4-4m4 4l4-4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>' :
            '<span>倒序排列</span><svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M10 4v12m0 0l-4-4m4 4l4-4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    }
}

// 页面加载时恢复排序状态
window.addEventListener('DOMContentLoaded', function () {
    // 从localStorage恢复排序状态
    const savedOrder = localStorage.getItem('episodesReversed');
    if (savedOrder !== null) {
        window.episodesReversed = savedOrder === 'true';
    }
    
    renderResourceInfoBar();
    renderEpisodeCards();
});

// 设置进度条准确点击处理
function setupProgressBarPreciseClicks() {
    // 查找DPlayer的进度条元素
    const progressBar = document.querySelector('.dplayer-bar-wrap');
    if (!progressBar || !art || !art.video) return;

    // 移除可能存在的旧事件监听器
    progressBar.removeEventListener('mousedown', handleProgressBarClick);

    // 添加新的事件监听器
    progressBar.addEventListener('mousedown', handleProgressBarClick);

    // 在移动端也添加触摸事件支持
    progressBar.removeEventListener('touchstart', handleProgressBarTouch);
    progressBar.addEventListener('touchstart', handleProgressBarTouch);

    // 处理进度条点击
    function handleProgressBarClick(e) {
        if (!art || !art.video) return;

        // 计算点击位置相对于进度条的比例
        const rect = e.currentTarget.getBoundingClientRect();
        const percentage = (e.clientX - rect.left) / rect.width;

        // 计算点击位置对应的视频时间
        const duration = art.video.duration;
        let clickTime = percentage * duration;

        // 处理视频接近结尾的情况
        if (duration - clickTime < 1) {
            // 如果点击位置非常接近结尾，稍微往前移一点
            clickTime = Math.min(clickTime, duration - 1.5);

        }

        // 记录用户点击的位置
        userClickedPosition = clickTime;

        // 阻止默认事件传播，避免DPlayer内部逻辑将视频跳至末尾
        e.stopPropagation();

        // 直接设置视频时间
        art.seek(clickTime);
    }

    // 处理移动端触摸事件
    function handleProgressBarTouch(e) {
        if (!art || !art.video || !e.touches[0]) return;

        const touch = e.touches[0];
        const rect = e.currentTarget.getBoundingClientRect();
        const percentage = (touch.clientX - rect.left) / rect.width;

        const duration = art.video.duration;
        let clickTime = percentage * duration;

        // 处理视频接近结尾的情况
        if (duration - clickTime < 1) {
            clickTime = Math.min(clickTime, duration - 1.5);
        }

        // 记录用户点击的位置
        userClickedPosition = clickTime;

        e.stopPropagation();
        art.seek(clickTime);
    }
}

// 在播放器初始化后添加视频到历史记录
function saveToHistory() {
    // 确保 currentEpisodes 非空且有当前视频URL
    if (!currentEpisodes || currentEpisodes.length === 0 || !currentVideoUrl) {
        return;
    }

    // 尝试从URL中获取参数
    const urlParams = new URLSearchParams(window.location.search);
    const sourceName = urlParams.get('source') || '';
    const sourceCode = urlParams.get('source_code') || '';
    const id_from_params = urlParams.get('id'); // Get video ID from player URL (passed as 'id')

    // 获取当前播放进度
    let currentPosition = 0;
    let videoDuration = 0;

    if (art && art.video) {
        currentPosition = art.video.currentTime;
        videoDuration = art.video.duration;
    }

    // Define a show identifier: Prioritize sourceName_id, fallback to first episode URL or current video URL
    let show_identifier_for_video_info;
    if (sourceName && id_from_params) {
        show_identifier_for_video_info = `${sourceName}_${id_from_params}`;
    } else {
        show_identifier_for_video_info = (currentEpisodes && currentEpisodes.length > 0) ? currentEpisodes[0] : currentVideoUrl;
    }

    // 构建要保存的视频信息对象
    const videoInfo = {
        title: currentVideoTitle,
        directVideoUrl: currentVideoUrl, // Current episode's direct URL
        url: `player.html?url=${encodeURIComponent(currentVideoUrl)}&title=${encodeURIComponent(currentVideoTitle)}&source=${encodeURIComponent(sourceName)}&source_code=${encodeURIComponent(sourceCode)}&id=${encodeURIComponent(id_from_params || '')}&index=${currentEpisodeIndex}&position=${Math.floor(currentPosition || 0)}`,
        episodeIndex: currentEpisodeIndex,
        sourceName: sourceName,
        vod_id: id_from_params || '', // Store the ID from params as vod_id in history item
        sourceCode: sourceCode,
        showIdentifier: show_identifier_for_video_info, // Identifier for the show/series
        timestamp: Date.now(),
        playbackPosition: currentPosition,
        duration: videoDuration,
        episodes: currentEpisodes && currentEpisodes.length > 0 ? [...currentEpisodes] : []
    };
    
    try {
        const history = JSON.parse(localStorage.getItem('viewingHistory') || '[]');

        // 检查是否已经存在相同的系列记录 (基于标题、来源和 showIdentifier)
        const existingIndex = history.findIndex(item => 
            item.title === videoInfo.title && 
            item.sourceName === videoInfo.sourceName && 
            item.showIdentifier === videoInfo.showIdentifier
        );

        if (existingIndex !== -1) {
            // 存在则更新现有记录的当前集数、时间戳、播放进度和URL等
            const existingItem = history[existingIndex];
            existingItem.episodeIndex = videoInfo.episodeIndex;
            existingItem.timestamp = videoInfo.timestamp;
            existingItem.sourceName = videoInfo.sourceName; // Should be consistent, but update just in case
            existingItem.sourceCode = videoInfo.sourceCode;
            existingItem.vod_id = videoInfo.vod_id;
            
            // Update URLs to reflect the current episode being watched
            existingItem.directVideoUrl = videoInfo.directVideoUrl; // Current episode's direct URL
            existingItem.url = videoInfo.url; // Player link for the current episode

            // 更新播放进度信息
            existingItem.playbackPosition = videoInfo.playbackPosition > 10 ? videoInfo.playbackPosition : (existingItem.playbackPosition || 0);
            existingItem.duration = videoInfo.duration || existingItem.duration;
            
            // 更新集数列表（如果新的集数列表与存储的不同，例如集数增加了）
            if (videoInfo.episodes && videoInfo.episodes.length > 0) {
                if (!existingItem.episodes || 
                    !Array.isArray(existingItem.episodes) || 
                    existingItem.episodes.length !== videoInfo.episodes.length || 
                    !videoInfo.episodes.every((ep, i) => ep === existingItem.episodes[i])) { // Basic check for content change
                    existingItem.episodes = [...videoInfo.episodes]; // Deep copy
                }
            }
            
            // 移到最前面
            const updatedItem = history.splice(existingIndex, 1)[0];
            history.unshift(updatedItem);
        } else {
            // 添加新记录到最前面
            history.unshift(videoInfo);
        }

        // 限制历史记录数量为50条
        if (history.length > 50) history.splice(50);

        localStorage.setItem('viewingHistory', JSON.stringify(history));
    } catch (e) {
    }
}

// 显示恢复位置提示
function showPositionRestoreHint(position) {
    if (!position || position < 10) return;

    // 创建提示元素
    const hint = document.createElement('div');
    hint.className = 'position-restore-hint';
    hint.innerHTML = `
        <div class="hint-content">
            已从 ${formatTime(position)} 继续播放
        </div>
    `;

    // 添加到播放器容器
    const playerContainer = document.querySelector('.player-container'); // Ensure this selector is correct
    if (playerContainer) { // Check if playerContainer exists
        playerContainer.appendChild(hint);
    } else {
        return; // Exit if container not found
    }

    // 显示提示
    setTimeout(() => {
        hint.classList.add('show');

        // 3秒后隐藏
        setTimeout(() => {
            hint.classList.remove('show');
            setTimeout(() => hint.remove(), 300);
        }, 3000);
    }, 100);
}

// 格式化时间为 mm:ss 格式
function formatTime(seconds) {
    if (isNaN(seconds)) return '00:00';

    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = Math.floor(seconds % 60);

    return `${minutes.toString().padStart(2, '0')}:${remainingSeconds.toString().padStart(2, '0')}`;
}

// 开始定期保存播放进度
function startProgressSaveInterval() {
    // 清除可能存在的旧计时器
    if (progressSaveInterval) {
        clearInterval(progressSaveInterval);
    }

    // 每30秒保存一次播放进度
    progressSaveInterval = setInterval(saveCurrentProgress, 30000);
}

// 保存当前播放进度
function saveCurrentProgress() {
    if (!art || !art.video) return;
    const currentTime = art.video.currentTime;
    const duration = art.video.duration;
    if (!duration || currentTime < 1) return;

    // 在localStorage中保存进度
    const progressKey = `videoProgress_${getVideoId()}`;
    const progressData = {
        position: currentTime,
        duration: duration,
        timestamp: Date.now()
    };
    try {
        localStorage.setItem(progressKey, JSON.stringify(progressData));
        // --- 新增：同步更新 viewingHistory 中的进度 ---
        try {
            const historyRaw = localStorage.getItem('viewingHistory');
            if (historyRaw) {
                const history = JSON.parse(historyRaw);
                // 用 title + 集数索引唯一标识
                const idx = history.findIndex(item =>
                    item.title === currentVideoTitle &&
                    (item.episodeIndex === undefined || item.episodeIndex === currentEpisodeIndex)
                );
                if (idx !== -1) {
                    // 只在进度有明显变化时才更新，减少写入
                    if (
                        Math.abs((history[idx].playbackPosition || 0) - currentTime) > 2 ||
                        Math.abs((history[idx].duration || 0) - duration) > 2
                    ) {
                        history[idx].playbackPosition = currentTime;
                        history[idx].duration = duration;
                        history[idx].timestamp = Date.now();
                        localStorage.setItem('viewingHistory', JSON.stringify(history));
                    }
                }
            }
        } catch (e) {
        }
    } catch (e) {
    }
}

// 设置移动端长按三倍速播放功能
function setupLongPressSpeedControl() {
    if (!art || !art.video) return;

    const playerElement = document.getElementById('player');
    let longPressTimer = null;
    let originalPlaybackRate = 1.0;
    let isLongPress = false;

    // 显示快速提示
    function showSpeedHint(speed) {
        showShortcutHint(`${speed}倍速`, 'right');
    }

    // 禁用右键
    playerElement.oncontextmenu = () => {
        // 检测是否为移动设备
        const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);

        // 只在移动设备上禁用右键
        if (isMobile) {
            const dplayerMenu = document.querySelector(".dplayer-menu");
            const dplayerMask = document.querySelector(".dplayer-mask");
            if (dplayerMenu) dplayerMenu.style.display = "none";
            if (dplayerMask) dplayerMask.style.display = "none";
            return false;
        }
        return true; // 在桌面设备上允许右键菜单
    };

    // 触摸开始事件
    playerElement.addEventListener('touchstart', function (e) {
        // 检查视频是否正在播放，如果没有播放则不触发长按功能
        if (art.video.paused) {
            return; // 视频暂停时不触发长按功能
        }

        // 保存原始播放速度
        originalPlaybackRate = art.video.playbackRate;

        // 设置长按计时器
        longPressTimer = setTimeout(() => {
            // 再次检查视频是否仍在播放
            if (art.video.paused) {
                clearTimeout(longPressTimer);
                longPressTimer = null;
                return;
            }

            // 长按超过500ms，设置为3倍速
            art.video.playbackRate = 3.0;
            isLongPress = true;
            showSpeedHint(3.0);

            // 只在确认为长按时阻止默认行为
            e.preventDefault();
        }, 500);
    }, { passive: false });

    // 触摸结束事件
    playerElement.addEventListener('touchend', function (e) {
        // 清除长按计时器
        if (longPressTimer) {
            clearTimeout(longPressTimer);
            longPressTimer = null;
        }

        // 如果是长按状态，恢复原始播放速度
        if (isLongPress) {
            art.video.playbackRate = originalPlaybackRate;
            isLongPress = false;
            showSpeedHint(originalPlaybackRate);

            // 阻止长按后的点击事件
            e.preventDefault();
        }
        // 如果不是长按，则允许正常的点击事件（暂停/播放）
    });

    // 触摸取消事件
    playerElement.addEventListener('touchcancel', function () {
        // 清除长按计时器
        if (longPressTimer) {
            clearTimeout(longPressTimer);
            longPressTimer = null;
        }

        // 如果是长按状态，恢复原始播放速度
        if (isLongPress) {
            art.video.playbackRate = originalPlaybackRate;
            isLongPress = false;
        }
    });

    // 触摸移动事件 - 防止在长按时触发页面滚动
    playerElement.addEventListener('touchmove', function (e) {
        if (isLongPress) {
            e.preventDefault();
        }
    }, { passive: false });

    // 视频暂停时取消长按状态
    art.video.addEventListener('pause', function () {
        if (isLongPress) {
            art.video.playbackRate = originalPlaybackRate;
            isLongPress = false;
        }

        if (longPressTimer) {
            clearTimeout(longPressTimer);
            longPressTimer = null;
        }
    });
}

// 清除视频进度记录
function clearVideoProgress() {
    const progressKey = `videoProgress_${getVideoId()}`;
    try {
        localStorage.removeItem(progressKey);
    } catch (e) {
    }
}

// 获取视频唯一标识
function getVideoId() {
    // 使用视频标题和集数索引作为唯一标识
    // If currentVideoUrl is available and more unique, prefer it. Otherwise, fallback.
    if (currentVideoUrl) {
        return `${encodeURIComponent(currentVideoUrl)}`;
    }
    return `${encodeURIComponent(currentVideoTitle)}_${currentEpisodeIndex}`;
}

let controlsLocked = false;
function toggleControlsLock() {
    const container = document.getElementById('playerContainer');
    controlsLocked = !controlsLocked;
    container.classList.toggle('controls-locked', controlsLocked);
    const icon = document.getElementById('lockIcon');
    // 切换图标：锁 / 解锁
    icon.innerHTML = controlsLocked
        ? '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d=\"M12 15v2m0-8V7a4 4 0 00-8 0v2m8 0H4v8h16v-8H6v-6z\"/>'
        : '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d=\"M15 11V7a3 3 0 00-6 0v4m-3 4h12v6H6v-6z\"/>';
}

// 支持在iframe中关闭播放器
function closeEmbeddedPlayer() {
    if (window.parent && typeof window.parent.closeVideoPlayer === 'function') {
        window.parent.closeVideoPlayer();
        return true;
    }
    try {
        if (window.top !== window.self) {
            window.top.postMessage({ type: 'CLOSE_PLAYER' }, '*');
            return true;
        }
    } catch (e) {
        console.error('尝试关闭嵌入式播放器失败:', e);
    }
    return false;
}

// 优化后的集数卡片渲染（icon只在当前集左侧）
function renderEpisodeCards() {
    const container = document.getElementById('episodeCardsContainer');
    if (!container) return;
    if (!window.currentEpisodes || window.currentEpisodes.length === 0) {
        container.innerHTML = '<div class="episode-card" style="opacity:0.5;cursor:default;">没有可用的集数</div>';
        return;
    }
    
    // 获取当前播放索引
    const urlParams = new URLSearchParams(window.location.search);
    const urlIndex = parseInt(urlParams.get('index') || '0', 10);
    
    // 确保currentEpisodeIndex始终使用URL中的index参数
    window.currentEpisodeIndex = urlIndex;
    
    console.log('渲染集数卡片，当前播放索引:', window.currentEpisodeIndex);
    
    const episodes = window.episodesReversed ? [...window.currentEpisodes].reverse() : window.currentEpisodes;
    let html = '';
    episodes.forEach((ep, idx) => {
        // 真实索引
        const realIndex = window.episodesReversed ? window.currentEpisodes.length - 1 - idx : idx;
        const isActive = realIndex === window.currentEpisodeIndex;
        
        // 添加调试日志
        if (isActive) {
            console.log('当前播放集:', realIndex + 1);
        }
        
        // 为确保高亮效果生效，使用内联样式和类共同作用
        const activeClass = isActive ? ' active' : '';
        
        // 使用style属性直接添加蓝色背景，确保高亮效果生效
        // 注意：为了最大兼容性，同时使用class和内联样式
        const activeStyle = isActive ? 
            'style="background-color: #3b82f6 !important; color: white !important; border: 2px solid #60a5fa !important; box-shadow: 0 0 0 2px rgba(59, 130, 246, 0.5) !important; font-weight: bold;"' : '';
        
        // 生成卡片HTML
        html += `<div class="episode-card${activeClass}" ${activeStyle} onclick="playEpisode(${realIndex})" tabindex="0" title="第${realIndex+1}集${isActive ? ' (当前播放)' : ''}">
          ${isActive ? '<span class="episode-icon" style="margin-right:4px;"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M12 22c5.523 0 10-4.477 10-10S17.523 2 12 2 2 6.477 2 12s4.477 10 10 10z" stroke="white" stroke-width="1.5"/><path d="M15.4 12.5l-5.8 3.86V8.64l5.8 3.86z" fill="white" stroke="white" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg></span>' : ''}
          <span class="episode-label"${isActive ? ' style="color: white !important; -webkit-text-fill-color: white !important; text-fill-color: white !important; background: none !important;"' : ''}>第${realIndex+1}集</span>
        </div>`;
    });
    container.innerHTML = html;
}

// 优化后的资源切换弹窗渲染
function showResourceModal() {
    const modal = document.getElementById('resourceModal');
    const list = document.getElementById('resourceModalList');
    if (!modal || !list || typeof API_SITES === 'undefined') return;
    const urlParams = new URLSearchParams(window.location.search);
    const currentSource = urlParams.get('source_code') || '';
    const currentIndex = parseInt(urlParams.get('index') || '0', 10);
    const title = urlParams.get('title') || document.getElementById('videoTitle').textContent || '';
    const resourceOptions = Object.entries(API_SITES)
        .filter(([key, val]) => !val.adult)
        .map(([key, val]) => ({ key, name: val.name }));
    
    // 显示加载中
    list.innerHTML = '<div style="text-align:center;padding:20px;color:#aaa;grid-column:1/-1;">正在加载资源列表...</div>';
    modal.style.display = 'flex';
    
    Promise.all(resourceOptions.map(async opt => {
        let count = '';
        try {
            if (title) {
                const result = await searchResourceByApiAndTitle(opt.key, title);
                if (result && result.length > 0 && result[0].vod_play_url_list) {
                    count = result[0].vod_play_url_list.length;
                } else {
                    count = 0;
                }
            }
        } catch (e) { count = 0; }
        return { ...opt, count };
    })).then(resourceWithCounts => {
        // 筛选出视频数大于0的资源
        const filteredResources = resourceWithCounts.filter(opt => {
            // 当前正在播放的资源始终显示，无论视频数是否为0
            if (opt.key === currentSource) return true;
            // 其他资源只有视频数大于0时才显示
            return opt.count > 0;
        });
        
        if (filteredResources.length === 0) {
            list.innerHTML = '<div style="text-align:center;padding:20px;color:#aaa;grid-column:1/-1;">未找到可用资源</div>';
            return;
        }
        
        list.innerHTML = filteredResources.map(opt =>
            `<div class="resource-modal-item${opt.key === currentSource ? ' active' : ''}" data-key="${opt.key}">
                <span>${opt.name}</span>
                <span>${opt.count !== '' ? opt.count + '个视频' : ''}</span>
                ${opt.key === currentSource ? '<div class="check-icon"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M20 6L9 17l-5-5"></path></svg></div>' : ''}
            </div>`
        ).join('');
        
        list.querySelectorAll('.resource-modal-item').forEach(item => {
            item.addEventListener('click', async function() {
                const newSource = item.getAttribute('data-key');
                if (!newSource) return;
                modal.style.display = 'none';
                try {
                    const searchResult = await searchResourceByApiAndTitle(newSource, title);
                    let episodeList = [];
                    if (searchResult && searchResult.length > 0) {
                        episodeList = searchResult[0].vod_play_url_list.map(item => item.url);
                    }
                    window.currentEpisodes = episodeList;
                    renderEpisodeCards();
                    let targetIndex = currentIndex;
                    if (targetIndex >= episodeList.length) targetIndex = 0;
                    const targetEpisode = episodeList[targetIndex];
                    if (targetEpisode) {
                        window.currentEpisodeIndex = targetIndex;
                        window.location.href = `player.html?url=${encodeURIComponent(targetEpisode)}&title=${encodeURIComponent(searchResult[0].vod_name)}&source_code=${newSource}&index=${targetIndex}`;
                        // 确保资源信息卡片更新 - 即使实际跳转前
                        renderResourceInfoBar();
                        return;
                    }
                    showToast('未找到同名资源', 'warning');
                } catch (e) {
                    window.currentEpisodes = [];
                    renderEpisodeCards();
                    showToast('资源搜索失败', 'error');
                }
            });
        });
    }).catch(err => {
        console.error('加载资源列表失败:', err);
        list.innerHTML = '<div style="text-align:center;padding:20px;color:#ff6b6b;grid-column:1/-1;">加载资源列表失败</div>';
    });
}

function hideResourceModal() {
    const modal = document.getElementById('resourceModal');
    if (modal) modal.style.display = 'none';
}

// 搜索指定API下的同名资源
async function searchResourceByApiAndTitle(apiKey, title) {
    // 复用api.js的API_SITES和API_CONFIG
    if (typeof API_SITES === 'undefined' || typeof API_CONFIG === 'undefined') return [];
    const api = API_SITES[apiKey];
    if (!api) return [];
    const url = api.api + API_CONFIG.search.path + encodeURIComponent(title);
    const resp = await fetch('/proxy/' + encodeURIComponent(url));
    const data = await resp.json();
    if (data && data.list && Array.isArray(data.list)) {
        // 兼容不同API返回结构
        return data.list.map(item => {
            // 兼容不同API字段
            return {
                vod_name: item.vod_name || item.name || '',
                vod_play_url_list: (item.vod_play_url && typeof item.vod_play_url === 'string') ?
                    item.vod_play_url.split('#').map((s, i) => ({ url: s.split('$')[1] || '', name: s.split('$')[0] || `第${i+1}集` })) : [],
            };
        });
    }
    return [];
}

// 绑定弹窗事件
window.addEventListener('DOMContentLoaded', function () {
    // 切换资源按钮弹窗
    const switchBtn = document.getElementById('switchResourceBtn');
    if (switchBtn) {
        switchBtn.addEventListener('click', function(e) {
            e.preventDefault();
            showResourceModal();
        });
    }
    // 关闭弹窗
    const closeBtn = document.getElementById('closeResourceModal');
    if (closeBtn) {
        closeBtn.addEventListener('click', function() {
            hideResourceModal();
        });
    }
    // 点击遮罩关闭
    const modal = document.getElementById('resourceModal');
    if (modal) {
        modal.addEventListener('click', function(e) {
            if (e.target === modal) hideResourceModal();
        });
    }
});

// 页面初始化时，拉取分集并渲染集数按钮（修正版）
window.addEventListener('DOMContentLoaded', async function () {
    // 删除不必要的日志
    // console.log('页面加载完成，开始初始化...');
    
    // 确保API_SITES已加载
    const ensureApiSitesLoaded = () => {
        return new Promise((resolve) => {
            if (typeof API_SITES !== 'undefined') {
                // 删除不必要的日志
                // console.log('API_SITES已加载');
                resolve();
            } else {
                // 删除不必要的日志
                // console.log('API_SITES未加载，尝试手动加载...');
                // 尝试手动加载api-sites.js
                const apiSitesScript = document.createElement('script');
                apiSitesScript.src = 'js/api-sites.js';
                apiSitesScript.onload = () => {
                    // 删除不必要的日志
                    // console.log('手动加载api-sites.js成功');
                    resolve();
                };
                apiSitesScript.onerror = () => {
                    console.error('手动加载api-sites.js失败');
                    resolve(); // 即使失败也继续执行
                };
                document.head.appendChild(apiSitesScript);
            }
        });
    };
    
    // 等待API_SITES加载完成
    await ensureApiSitesLoaded();
    
    const urlParams = new URLSearchParams(window.location.search);
    const sourceCode = urlParams.get('source_code') || '';
    const title = urlParams.get('title') || '';
    
    // 如果URL中没有source_code参数，尝试从视频URL推断
    if (!sourceCode && urlParams.get('url')) {
        try {
            const videoUrl = urlParams.get('url');
            const videoUrlObj = new URL(videoUrl);
            const videoHost = videoUrlObj.hostname;
            
            // 尝试匹配API
            if (typeof API_SITES !== 'undefined') {
                for (const [key, api] of Object.entries(API_SITES)) {
                    try {
                        const apiUrlObj = new URL(api.api);
                        if (videoHost === apiUrlObj.hostname || 
                            videoUrl.includes(api.api) || 
                            (api.detail && videoUrl.includes(api.detail))) {
                            
                            // 找到匹配的API，添加source_code到URL
                            // 删除不必要的日志
                            // console.log('从视频URL推断出source_code:', key);
                            const newUrl = new URL(window.location.href);
                            newUrl.searchParams.set('source_code', key);
                            window.history.replaceState({}, '', newUrl.toString());
                            break;
                        }
                    } catch (e) {}
                }
            }
        } catch (e) {
            console.error('尝试从URL推断source_code失败:', e);
        }
    }
    
    if (typeof API_SITES !== 'undefined' && sourceCode && title) {
        try {
            // 删除不必要的日志
            // console.log(`开始搜索资源: ${sourceCode}, ${title}`);
            const searchResult = await searchResourceByApiAndTitle(sourceCode, title);
            if (searchResult && searchResult.length > 0) {
                window.currentEpisodes = searchResult[0].vod_play_url_list.map(item => item.url);
                localStorage.setItem('currentEpisodes', JSON.stringify(window.currentEpisodes));
                // 删除不必要的日志
                // console.log(`找到 ${window.currentEpisodes.length} 个视频`);
            } else {
                window.currentEpisodes = [];
                localStorage.setItem('currentEpisodes', '[]');
                // 删除不必要的日志
                // console.log('未找到匹配的视频');
            }
        } catch (e) {
            console.error('搜索资源失败:', e);
            window.currentEpisodes = [];
            localStorage.setItem('currentEpisodes', '[]');
        }
    } else {
        // 兜底：尝试从localStorage恢复
        try {
            window.currentEpisodes = JSON.parse(localStorage.getItem('currentEpisodes') || '[]');
            // 删除不必要的日志
            // console.log(`从缓存恢复了 ${window.currentEpisodes.length} 个视频`);
        } catch (e) {
            console.error('从缓存恢复失败:', e);
            window.currentEpisodes = [];
        }
    }
    
    // 渲染UI
    renderEpisodeCards();
    renderResourceInfoBar();
    updateEpisodeInfo && updateEpisodeInfo();
});

// ========== 新UI渲染逻辑 =============

// 渲染资源信息卡片（顶部）
function renderResourceInfoBar() {
    // 删除不必要的日志
    // console.log('开始渲染资源信息卡片');
    
    // 获取容器元素
    const container = document.getElementById('resourceInfoBarContainer');
    if (!container) {
        console.error('找不到资源信息卡片容器');
        return;
    }
    
    // 获取当前视频URL和source_code
    const urlParams = new URLSearchParams(window.location.search);
    const currentSource = urlParams.get('source_code') || '';
    const title = urlParams.get('title') || document.getElementById('videoTitle')?.textContent || '';
    const videoUrl = urlParams.get('url') || '';
    
    // 删除不必要的日志
    // console.log(`当前参数 - source_code: "${currentSource}", title: "${title}", video_url: "${videoUrl.substring(0, 50)}..."`);
    
    // 显示临时加载状态
    container.innerHTML = `
      <div class="resource-info-bar-left">
        <span>加载中...</span>
        <span class="resource-info-bar-videos">-</span>
      </div>
      <button class="resource-switch-btn" id="switchResourceBtn">
        <span class="resource-switch-icon">
          <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M12 4v16m0 0l-6-6m6 6l6-6" stroke="#a67c2d" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </span>
        切换资源
      </button>
    `;
    
    // 查找当前资源名称 - 使用多种方法尝试
    let resourceName = '未知资源';
    let foundResource = false;
    
    // 视频数量统计
    let videoCount = window.currentEpisodes && window.currentEpisodes.length ? window.currentEpisodes.length : 0;
    
    // 直接从URL中提取域名作为兜底
    try {
        let domainFromUrl = '';
        if (videoUrl) {
            const urlObj = new URL(videoUrl);
            domainFromUrl = urlObj.hostname;
            // 删除不必要的日志
            // if (domainFromUrl) {
            //     console.log('从URL中提取的域名:', domainFromUrl);
            // }
        }
        
        // 函数：从API_SITES中查找最匹配的API
        const findMatchingApi = () => {
            // 确保API_SITES已加载
            if (typeof API_SITES === 'undefined' || !API_SITES) {
                console.error('API_SITES未定义，尝试加载...');
                try {
                    // 尝试加载api-sites.js
                    const script = document.createElement('script');
                    script.src = 'js/api-sites.js';
                    script.onload = () => {
                        // 删除不必要的日志
                        // console.log('成功加载API_SITES，重新渲染资源信息');
                        setTimeout(renderResourceInfoBar, 100);
                    };
                    document.head.appendChild(script);
                } catch (e) {
                    console.error('加载API_SITES失败:', e);
                }
                return false;
            }
            
            // 方法1：直接通过source_code匹配
            if (currentSource && API_SITES[currentSource]) {
                resourceName = API_SITES[currentSource].name;
                // 删除不必要的日志
                // console.log('通过source_code直接匹配成功:', resourceName);
                return true;
            } 
            
            // 方法2：如果是自定义API
            if (currentSource && currentSource.startsWith('custom_')) {
                try {
                    const customAPIs = JSON.parse(localStorage.getItem('customAPIs') || '[]');
                    const customIndex = parseInt(currentSource.replace('custom_', ''), 10);
                    if (customAPIs[customIndex]) {
                        resourceName = customAPIs[customIndex].name || '自定义资源';
                        // 删除不必要的日志
                        // console.log('通过自定义API匹配成功:', resourceName);
                        return true;
                    }
                } catch (e) {
                    console.error('获取自定义API信息失败:', e);
                }
            } 
    
            // 方法3：通过视频URL域名匹配 - 继续其他匹配方法
            if (videoUrl && domainFromUrl) {
                for (const [key, api] of Object.entries(API_SITES)) {
                    // 通过API URL匹配
                    try {
                        const apiUrlObj = new URL(api.api);
                        const apiHost = apiUrlObj.hostname;
                        
                        // 域名完全匹配
                        if (domainFromUrl === apiHost) {
                resourceName = api.name;
                            // 删除不必要的日志
                            // console.log('通过域名完全匹配成功:', resourceName);
                            return true;
                        }
                        
                        // 域名部分匹配
                        if (domainFromUrl.includes(apiHost) || apiHost.includes(domainFromUrl)) {
                            resourceName = api.name;
                            // 删除不必要的日志
                            // console.log('通过域名部分匹配成功:', resourceName);
                            return true;
            }
            
                        // 通过detail匹配
                        if (api.detail) {
            try {
                                const detailUrlObj = new URL(api.detail);
                                const detailHost = detailUrlObj.hostname;
                                if (domainFromUrl === detailHost || domainFromUrl.includes(detailHost) || detailHost.includes(domainFromUrl)) {
                                    resourceName = api.name;
                                    // 删除不必要的日志
                                    // console.log('通过detail域名匹配成功:', resourceName);
                                    return true;
                                }
                            } catch (e) {}
                        }
                        
                        // 通过URL字符串匹配
                        if (videoUrl.includes(api.api) || (api.detail && videoUrl.includes(api.detail))) {
                    resourceName = api.name;
                            // 删除不必要的日志
                            // console.log('通过URL字符串匹配成功:', resourceName);
                            return true;
                }
            } catch (e) {
                        console.error('域名匹配出错:', e);
            }
        }
    }
    
            // 方法4：通过source_code部分匹配
            if (currentSource) {
                for (const [key, api] of Object.entries(API_SITES)) {
                    if (key.toLowerCase().includes(currentSource.toLowerCase()) || 
                        currentSource.toLowerCase().includes(key.toLowerCase())) {
                        resourceName = api.name;
                        // 删除不必要的日志
                        // console.log('通过source_code部分匹配成功:', resourceName);
                        return true;
                    }
                }
            }
            
            // 方法5：通过标题猜测
            if (title) {
                // 如果标题中包含某些特定关键词，可以尝试猜测
                const keywordMap = {
                    '黑木耳': 'heimuer',
                    '电影天堂': 'dyttzy',
                    '如意': 'ruyi',
                    '暴风': 'bfzy',
                    '天涯': 'tyyszy',
                    '非凡': 'ffzy',
                    '360': 'zy360',
                    '爱奇艺': 'iqiyi',
                    '卧龙': 'wolong',
                    '华为': 'hwba',
                    '极速': 'jisu',
                    '豆瓣': 'dbzy',
                    '魔爪': 'mozhua',
                    '魔都': 'mdzy',
                    '最大': 'zuid',
                    '樱花': 'yinghua',
                    '百度': 'baidu',
                    '无尽': 'wujin'
                };
                
                for (const [keyword, apiKey] of Object.entries(keywordMap)) {
                    if (title.includes(keyword) && API_SITES[apiKey]) {
                        resourceName = API_SITES[apiKey].name;
                        // 删除不必要的日志
                        // console.log('通过标题关键词匹配成功:', resourceName);
                        return true;
                    }
                }
            }
            
            // 方法6：最后尝试第一个可用的API名称作为兜底
            const apiKeys = Object.keys(API_SITES);
            if (apiKeys.length > 0) {
                resourceName = API_SITES[apiKeys[0]].name;
                // 删除不必要的日志
                // console.log('使用第一个可用API作为兜底:', resourceName);
                return true;
            }
            
            return false;
        };
        
        // 执行查找
        foundResource = findMatchingApi();
        
        // 如果仍未找到，使用域名作为资源名称
        if (!foundResource && domainFromUrl) {
            resourceName = domainFromUrl.replace(/^www\./, '');
            // 删除不必要的日志
            // console.log('使用视频域名作为资源名称:', resourceName);
            foundResource = true;
        }
    } catch (e) {
        console.error('查找资源名称时出错:', e);
    }
    
    // 更新UI显示
    // 删除不必要的日志
    // console.log('最终资源名称:', resourceName, '视频数:', videoCount);
    container.innerHTML = `
      <div class="resource-info-bar-left">
        <span>${resourceName}</span>
        <span class="resource-info-bar-videos">${videoCount} 个视频</span>
      </div>
      <button class="resource-switch-btn" id="switchResourceBtn">
        <span class="resource-switch-icon">
          <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M12 4v16m0 0l-6-6m6 6l6-6" stroke="#a67c2d" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </span>
        切换资源
      </button>
    `;
    
    // 绑定切换资源弹窗事件
    const switchBtn = document.getElementById('switchResourceBtn');
    if (switchBtn) {
      switchBtn.onclick = function(e) {
        e.preventDefault();
        showResourceModal && showResourceModal();
      };
    }
}

// 重载playEpisode，切换集数后刷新UI
const _oldPlayEpisode = window.playEpisode;
window.playEpisode = function(index) {
    if (typeof _oldPlayEpisode === 'function') _oldPlayEpisode(index);
    
    // 更新当前播放索引
    window.currentEpisodeIndex = index;
    
    // 渲染集数卡片，确保高亮效果
    renderEpisodeCards();
    
    // 自动跳转到对应集数的URL
    const urlParams = new URLSearchParams(window.location.search);
    const sourceCode = urlParams.get('source_code') || '';
    const title = urlParams.get('title') || '';
    const episodeUrl = window.currentEpisodes[index];
    
    if (episodeUrl) {
        console.log(`跳转到第${index+1}集，资源源: ${sourceCode}`);
        window.location.href = `player.html?url=${encodeURIComponent(episodeUrl)}&title=${encodeURIComponent(title)}&source_code=${sourceCode}&index=${index}`;
    }
};

// 页面初始化时渲染新UI
window.addEventListener('DOMContentLoaded', function () {
    console.log("页面DOM内容加载完成，开始加载API和渲染UI");
    
    // 确保API_SITES已加载
    const loadApiSites = () => {
        return new Promise((resolve) => {
            if (typeof API_SITES !== 'undefined' && API_SITES) {
                console.log("API_SITES已加载");
                resolve(true);
                return;
            }
            
            console.log("API_SITES未加载，尝试手动加载...");
            const script = document.createElement('script');
            script.src = 'js/api-sites.js';
            script.onload = () => {
                console.log("手动加载API_SITES成功");
                setTimeout(() => resolve(true), 100);
            };
            script.onerror = () => {
                console.error("手动加载API_SITES失败");
                resolve(false);
            };
            document.head.appendChild(script);
            
            // 设置超时
            setTimeout(() => resolve(false), 5000);
        });
    };
    
    // 异步加载API并渲染UI
    (async () => {
        const apiLoaded = await loadApiSites();
        if (apiLoaded) {
            console.log("API加载成功，开始渲染资源信息卡片");
        renderResourceInfoBar();
    } else {
            console.error("API加载失败，尝试使用默认渲染");
            }
        
        // 无论API加载是否成功，都要渲染集数卡片
    renderEpisodeCards();
    })();
    
    // 确保URL中的index参数被正确应用
    const urlParams = new URLSearchParams(window.location.search);
    const urlIndex = parseInt(urlParams.get('index') || '0', 10);
    window.currentEpisodeIndex = urlIndex;
    
    // 渲染集数卡片并应用高亮
    renderEpisodeCards();
    
    // 由于页面可能有延迟加载的内容，延迟再次渲染以确保高亮效果
    setTimeout(() => {
        renderEpisodeCards();
        renderResourceInfoBar(); // 再次尝试渲染资源信息卡片
    }, 1000);
});
