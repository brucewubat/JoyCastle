class ShortConnectionManager {
  constructor() {
    // 配置参数
    this.config = {
      baseUrl: "https://api.casualgame.com",
      timeout: {
        normal: 5000,    // 普通请求超时
        largeData: 15000, // 大数据请求超时
        longPoll: 30000   // 长轮询超时
      },
      maxRetries: 3,       // 最大重试次数
      retryDelay: [1000, 3000, 5000], // 重试延迟（指数退避）
      maxConcurrent: 3,    // 最大并发请求数
      cacheTTL: {          // 缓存过期时间（毫秒）
        config: 3600000,   // 配置数据1小时
        userData: 60000,   // 用户数据1分钟
        temp: 5000         // 临时数据5秒
      }
    };

    // 请求队列（按优先级排序）
    this.requestQueue = [];
    // 当前并发请求数
    this.activeRequests = 0;
    // 缓存存储
    this.cache = new Map();
    // 断网时的请求缓存队列
    this.offlineQueue = this.loadOfflineQueue();
    // 网络状态
    this.isOnline = navigator.onLine;

    // 初始化网络监听
    this.initNetworkListener();
  }

  // 初始化网络状态监听
  initNetworkListener() {
    window.addEventListener('online', () => {
      this.isOnline = true;
      this.emit('networkChange', true);
      // 网络恢复后处理离线队列
      this.processOfflineQueue();
    });

    window.addEventListener('offline', () => {
      this.isOnline = false;
      this.emit('networkChange', false);
    });
  }

  // 基础请求方法
  request(method, path, data = {}, options = {}) {
    // 合并配置选项
    const opts = {
      priority: 5,          // 默认优先级（1-10，1最高）
      timeout: this.config.timeout.normal,
      retries: this.config.maxRetries,
      cache: false,         // 是否启用缓存
      cacheType: 'temp',    // 缓存类型
      isLongPoll: false,    // 是否为长轮询
      skipOfflineQueue: false, // 是否跳过离线队列
      ...options
    };

    // 如果断网且不跳过离线队列，则加入离线队列
    if (!this.isOnline && !opts.skipOfflineQueue) {
      this.offlineQueue.push({ method, path, data, options: opts });
      this.saveOfflineQueue();
      return Promise.reject(new Error('Network offline, request queued'));
    }

    // 如果启用缓存且存在有效缓存，则直接返回缓存
    if (opts.cache) {
      const cacheKey = this.generateCacheKey(method, path, data);
      const cachedData = this.getCache(cacheKey, opts.cacheType);
      if (cachedData) {
        return Promise.resolve(cachedData);
      }
    }

    // 创建请求Promise
    const requestPromise = new Promise((resolve, reject) => {
      // 构建完整URL
      const url = `${this.config.baseUrl}${path}`;
      
      // 构建请求参数
      const fetchOptions = {
        method,
        headers: this.getHeaders(opts),
        signal: AbortSignal.timeout(opts.timeout)
      };

      // 处理请求数据
      if (method !== 'GET') {
        fetchOptions.body = this.serializeData(data);
      } else {
        // GET请求参数拼接到URL
        const queryString = new URLSearchParams(data).toString();
        url += queryString ? `?${queryString}` : '';
      }

      // 执行请求
      this.executeRequest(url, fetchOptions, opts, 0)
        .then(response => {
          // 如果启用缓存，存储响应结果
          if (opts.cache) {
            const cacheKey = this.generateCacheKey(method, path, data);
            this.setCache(cacheKey, response, opts.cacheType);
          }
          resolve(response);
        })
        .catch(error => reject(error));
    });

    // 加入请求队列等待执行
    this.requestQueue.push({
      promise: requestPromise,
      priority: opts.priority
    });

    // 按优先级排序队列
    this.requestQueue.sort((a, b) => a.priority - b.priority);

    // 处理请求队列
    this.processRequestQueue();

    return requestPromise;
  }

  // 执行实际请求（带重试逻辑）
  executeRequest(url, options, opts, retryCount) {
    return fetch(url, options)
      .then(response => {
        // 处理HTTP错误状态
        if (!response.ok) {
          // 401未授权，触发重新登录
          if (response.status === 401) {
            this.emit('unauthorized');
            throw new Error('Authentication required');
          }
          // 5xx服务器错误可重试，4xx客户端错误不可重试
          if (response.status >= 500 && retryCount < opts.retries) {
            throw new Error(`Server error: ${response.status}, retryable`);
          }
          throw new Error(`HTTP error: ${response.status}`);
        }
        
        // 解析响应数据
        return response.headers.get('Content-Type').includes('application/json')
          ? response.json().then(data => this.decryptData(data))
          : response.text();
      })
      .catch(error => {
        // 检查是否可以重试
        if (retryCount < opts.retries && this.isRetryableError(error)) {
          const delay = this.config.retryDelay[retryCount] || 5000;
          return new Promise(resolve => setTimeout(resolve, delay))
            .then(() => this.executeRequest(url, options, opts, retryCount + 1));
        }
        throw error;
      });
  }

  // 处理请求队列（控制并发）
  processRequestQueue() {
    // 如果未达到最大并发且队列不为空，则继续处理
    while (this.activeRequests < this.config.maxConcurrent && this.requestQueue.length > 0) {
      this.activeRequests++;
      const { promise } = this.requestQueue.shift();
      
      // 请求完成后更新并发计数
      promise.finally(() => {
        this.activeRequests--;
        this.processRequestQueue(); // 继续处理队列
      });
    }
  }

  // 处理离线队列
  processOfflineQueue() {
    if (this.offlineQueue.length === 0) return;

    // 按顺序执行离线队列中的请求
    const processNext = () => {
      if (this.offlineQueue.length === 0) return;
      
      const { method, path, data, options } = this.offlineQueue[0];
      this.request(method, path, data, { ...options, skipOfflineQueue: true })
        .then(() => {
          this.offlineQueue.shift();
          this.saveOfflineQueue();
          processNext();
        })
        .catch(error => {
          console.error('Failed to process offline request:', error);
          // 处理失败，保留在队列中稍后重试
        });
    };

    processNext();
  }

  // 生成缓存键
  generateCacheKey(method, path, data) {
    return `${method}:${path}:${JSON.stringify(data)}`;
  }

  // 获取缓存
  getCache(key, type) {
    const entry = this.cache.get(key);
    if (!entry) return null;
    
    // 检查缓存是否过期
    const now = Date.now();
    if (now - entry.timestamp < this.config.cacheTTL[type]) {
      return entry.data;
    }
    
    // 缓存过期，移除
    this.cache.delete(key);
    return null;
  }

  // 设置缓存
  setCache(key, data, type) {
    this.cache.set(key, {
      data,
      timestamp: Date.now(),
      type
    });
  }

  // 清除缓存
  clearCache(type) {
    if (type) {
      // 清除特定类型的缓存
      for (const [key, entry] of this.cache.entries()) {
        if (entry.type === type) {
          this.cache.delete(key);
        }
      }
    } else {
      // 清除所有缓存
      this.cache.clear();
    }
  }

  // 加载离线队列（从本地存储）
  loadOfflineQueue() {
    try {
      const stored = localStorage.getItem('offlineRequestQueue');
      return stored ? JSON.parse(stored) : [];
    } catch (error) {
      console.error('Failed to load offline queue:', error);
      return [];
    }
  }

  // 保存离线队列（到本地存储）
  saveOfflineQueue() {
    try {
      localStorage.setItem('offlineRequestQueue', JSON.stringify(this.offlineQueue));
    } catch (error) {
      console.error('Failed to save offline queue:', error);
    }
  }

  // 构建请求头
  getHeaders(options) {
    const headers = {
      'Content-Type': 'application/json',
      'X-Request-Time': Date.now().toString(),
      'X-App-Version': '1.0.0' // 应用版本号
    };

    // 添加认证信息
    if (!options.noAuth) {
      const token = this.getAuthToken();
      if (token) {
        headers['Authorization'] = `Bearer ${token}`;
      }
    }

    // 添加请求签名（防篡改）
    headers['X-Signature'] = this.generateSignature(options);

    return headers;
  }

  // 生成请求签名
  generateSignature(options) {
    // 实际项目中应使用更安全的签名算法
    const nonce = this.generateNonce();
    const timestamp = Date.now().toString();
    const secretKey = 'your-secret-key'; // 客户端与服务器共享的密钥
    
    // 签名源字符串
    const source = `${nonce}:${timestamp}:${secretKey}`;
    
    // 简化的签名计算（实际应使用SHA256等算法）
    return btoa(source);
  }

  // 生成随机数（防重放攻击）
  generateNonce() {
    return Math.random().toString(36).substring(2, 15);
  }

  // 获取认证令牌
  getAuthToken() {
    return localStorage.getItem('authToken') || '';
  }

  // 序列化请求数据
  serializeData(data) {
    return JSON.stringify(this.encryptData(data));
  }

  // 加密数据（简化版）
  encryptData(data) {
    // 实际项目中应使用AES等加密算法
    return data;
  }

  // 解密数据（简化版）
  decryptData(data) {
    // 实际项目中对应解密逻辑
    return data;
  }

  // 判断错误是否可重试
  isRetryableError(error) {
    // 网络错误、超时、服务器错误可重试
    return error.name === 'TypeError' || // 网络错误
           error.name === 'AbortError' || // 超时
           (error.message && error.message.includes('retryable'));
  }

  // 事件监听相关方法
  on(event, callback) {
    if (!this.eventListeners) this.eventListeners = new Map();
    if (!this.eventListeners.has(event)) {
      this.eventListeners.set(event, []);
    }
    this.eventListeners.get(event).push(callback);
  }

  emit(event, ...args) {
    if (this.eventListeners && this.eventListeners.has(event)) {
      this.eventListeners.get(event).forEach(callback => callback(...args));
    }
  }

  // 便捷的请求方法
  get(path, data = {}, options = {}) {
    return this.request('GET', path, data, options);
  }

  post(path, data = {}, options = {}) {
    return this.request('POST', path, data, options);
  }

  put(path, data = {}, options = {}) {
    return this.request('PUT', path, data, options);
  }

  delete(path, data = {}, options = {}) {
    return this.request('DELETE', path, data, options);
  }

  // 长轮询请求（用于模拟实时性）
  longPoll(path, data = {}, options = {}) {
    return this.request('GET', path, data, {
      ...options,
      isLongPoll: true,
      timeout: this.config.timeout.longPoll,
      retries: Infinity // 长轮询无限重试
    }).then(response => {
      // 长轮询返回后立即发起下一次请求，保持"准实时"
      this.longPoll(path, data, options);
      return response;
    });
  }
}

// 使用示例
const network = new ShortConnectionManager();

// 监听网络状态变化
network.on('networkChange', (isOnline) => {
  console.log('Network status:', isOnline ? 'online' : 'offline');
});

// 监听未授权事件（需要重新登录）
network.on('unauthorized', () => {
  console.log('Need to re-login');
  // 跳转到登录页面
});

// 获取游戏配置（高优先级，带缓存）
network.get('/config', {}, {
  priority: 1,
  cache: true,
  cacheType: 'config'
}).then(config => {
  console.log('Game config:', config);
});

// 提交玩家分数（中优先级，不缓存）
network.post('/player/score', {
  score: 1250,
  level: 5
}, {
  priority: 3
}).then(response => {
  console.log('Score submitted:', response);
}).catch(error => {
  console.error('Failed to submit score:', error);
});

// 长轮询获取好友动态（模拟实时通知）
network.longPoll('/friend/updates', { lastId: 100 }, {
  priority: 7
}).then(update => {
  console.log('New friend update:', update);
});
    