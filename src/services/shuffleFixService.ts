/**
 * 
 * Fixes SoundCloud's shuffle limitation where it only shuffles currently loaded tracks instead of the entire playlist/collection.
 * 
 * 1. Patches collection limits to fetch more tracks per request
 * 2. Intercepts the shuffle function to pre-load all tracks before shuffling
 * 3. Modifies XHR requests to use higher limit parameters
 * 
 */

export const shuffleFixScript = `
(function() {
    const MAX_LIMIT = __MAX_LIMIT__;

    function findWebpackRequire() {
        if (typeof window.webpackJsonp !== 'undefined') {
            let requireFunc = null;
            window.webpackJsonp.push([[], {'_': function(module, exports, __webpack_require__) { requireFunc = __webpack_require__; }}, [['_']]]);
            return requireFunc;
        }
        for (const key in window) {
            if (key.startsWith('webpackChunk')) {
                const chunk = window[key];
                if (Array.isArray(chunk)) {
                    let requireFunc = null;
                    chunk.push([['_'], {'_': function(module, exports, __webpack_require__) { requireFunc = __webpack_require__; }}, [['_']]]);
                    if (requireFunc) return requireFunc;
                }
            }
        }
        return null;
    }

    function patchCollections(webpackRequire) {
        const cache = webpackRequire.c || {};
        for (const moduleId in cache) {
            try {
                const moduleExports = cache[moduleId]?.exports;
                if (moduleExports?.prototype) {
                    const proto = moduleExports.prototype;
                    if (proto.defaults?.limit !== undefined) {
                        proto.defaults.limit = MAX_LIMIT;
                        proto.defaults.maxPageSize = MAX_LIMIT;
                    }
                    if (typeof proto.setLimit === 'function' && !proto.setLimit._patched) {
                        const originalSetLimit = proto.setLimit;
                        proto.setLimit = function(limit) {
                            return originalSetLimit.call(this, Math.max(limit, MAX_LIMIT));
                        };
                        proto.setLimit._patched = true;
                    }
                }
            } catch (e) {}
        }
    }

    function patchShuffle(webpackRequire) {
        const cache = webpackRequire.c || {};
        for (const moduleId in cache) {
            try {
                const moduleExports = cache[moduleId]?.exports;
                if (moduleExports?.states?.shuffle?.setup) {
                    const originalSetup = moduleExports.states.shuffle.setup;
                    moduleExports.states.shuffle.setup = function() {
                        const queue = moduleExports.getQueue?.();
                        if (queue?.next_href && queue.next_href !== false) {
                            console.warn('Queue has more pages -', queue.length, 'tracks loaded');
                        }
                        return originalSetup.apply(this, arguments);
                    };
                }
                if (moduleExports?.toggleShuffle && moduleExports?.getQueue && !moduleExports.toggleShuffle._patched) {
                    const originalToggleShuffle = moduleExports.toggleShuffle;
                    let isLoading = false;
                    let loadingTimeout = null;
                    
                    moduleExports.toggleShuffle = async function() {
                        const shuffleButtonElement = document.querySelector('.shuffleControl');
                        const isShuffleActive = shuffleButtonElement?.classList.contains('m-shuffling');
                        
                        if (isShuffleActive) {
                            console.log('Disabling shuffle');
                            return originalToggleShuffle.apply(this, arguments);
                        }
                        
                        if (isLoading) {
                            console.log('Already loading tracks!');
                            return;
                        }
                        
                        if (shuffleButtonElement) {
                            shuffleButtonElement.style.pointerEvents = 'none';
                            shuffleButtonElement.style.opacity = '0.5';
                        }
                        
                        const queue = moduleExports.getQueue();
                        if (queue) {
                            const initialLength = queue.length;
                            const hasMore = moduleExports.hasMoreAhead && moduleExports.hasMoreAhead();
                            
                            if (!hasMore) {
                                console.log('All', initialLength, 'tracks already loaded in queue');
                                if (shuffleButtonElement) {
                                    shuffleButtonElement.style.pointerEvents = '';
                                    shuffleButtonElement.style.opacity = '';
                                }
                                originalToggleShuffle.call(this);
                                return;
                            }
                            
                            if (hasMore) {
                                isLoading = true;
                                
                                loadingTimeout = setTimeout(() => {
                                    isLoading = false;
                                    console.warn('Loading timeout reached (60s), releasing lock and restoring button');
                                    if (shuffleButtonElement) {
                                        shuffleButtonElement.style.pointerEvents = '';
                                        shuffleButtonElement.style.opacity = '';
                                    }
                                }, 60000);
                                
                                try {
                                    console.log('Enabling shuffle - loading all tracks...');
                                    console.log('Current queue length:', initialLength);
                                    
                                    let waitIterations = 0;
                                    let lastLength = initialLength;
                                    const maxBatchSize = 1000;
                                    
                                    while (waitIterations < 200) {
                                        const hasMoreTracks = moduleExports.hasMoreAhead && moduleExports.hasMoreAhead();
                                        
                                        if (!hasMoreTracks) {
                                            console.log('Stream ended - all tracks loaded');
                                            break;
                                        }
                                        
                                        if (moduleExports.pullNext) {
                                            try {
                                                moduleExports.pullNext(maxBatchSize);
                                            } catch (e) {
                                                console.error('Error calling pullNext:', e);
                                                break;
                                            }
                                        }
                                        
                                        await new Promise(resolve => setTimeout(resolve, 150));
                                        
                                        if (queue.length > lastLength) {
                                            const loaded = queue.length - lastLength;
                                            lastLength = queue.length;
                                            waitIterations = 0;
                                            console.log('Queue now has', lastLength, 'tracks (+' + loaded + ')');
                                        } else {
                                            waitIterations++;
                                        }
                                    }
                                    
                                    if (waitIterations >= 200) {
                                        console.warn('Loading stopped after 200 iterations of no progress');
                                    }
                                    
                                    console.log('Finished - queue loaded with', queue.length, 'tracks (was', initialLength, ')');
                                    
                                    originalToggleShuffle.call(this);
                                } catch (error) {
                                    console.error('Error during track loading:', error);
                                } finally {
                                    isLoading = false;
                                    if (loadingTimeout) {
                                        clearTimeout(loadingTimeout);
                                        loadingTimeout = null;
                                    }
                                    if (shuffleButtonElement) {
                                        shuffleButtonElement.style.pointerEvents = '';
                                        shuffleButtonElement.style.opacity = '';
                                    }
                                }
                            }
                        }
                    };
                    moduleExports.toggleShuffle._patched = true;
                }
            } catch (e) {}
        }
    }

    function patchXHR() {
        const OriginalXHR = window.XMLHttpRequest;
        window.XMLHttpRequest = function() {
            const xhr = new OriginalXHR();
            const originalOpen = xhr.open;
            xhr.open = function(method, url, ...args) {
                if (typeof url === 'string' && url.includes('api')) {
                    try {
                        const urlObj = new URL(url, window.location.origin);
                        if (url.match(/\\/(likes|tracks|playlists|favorites|stream)/)) {
                            const currentLimit = urlObj.searchParams.get('limit');
                            if (currentLimit && parseInt(currentLimit) < MAX_LIMIT) {
                                urlObj.searchParams.set('limit', MAX_LIMIT.toString());
                                url = urlObj.toString();
                            }
                        }
                    } catch (e) {}
                }
                return originalOpen.call(this, method, url, ...args);
            };
            return xhr;
        };
        Object.setPrototypeOf(window.XMLHttpRequest, OriginalXHR);
        window.XMLHttpRequest.prototype = OriginalXHR.prototype;
    }

    const webpackRequire = findWebpackRequire();
    if (webpackRequire) {
        patchCollections(webpackRequire);
        patchShuffle(webpackRequire);
        console.log('Successfully patched webpack modules');
    } else {
        console.warn('Could not find webpack require function');
    }
    patchXHR();
    console.log('Initialized with MAX_LIMIT:', MAX_LIMIT);
})();
`;
