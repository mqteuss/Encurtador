const express = require('express');
const cors = require('cors');
const http = require('http');
const https = require('https');
const { URL } = require('url');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

/**
 * Follow redirects manually to track the full chain
 * @param {string} url - The URL to resolve
 * @param {number} maxRedirects - Max number of redirects to follow
 * @returns {Promise<{finalUrl: string, chain: string[], statusCode: number}>}
 */
function resolveUrl(url, maxRedirects = 20) {
  return new Promise((resolve, reject) => {
    const chain = [url];
    let redirectCount = 0;

    function follow(currentUrl) {
      if (redirectCount >= maxRedirects) {
        return resolve({
          finalUrl: currentUrl,
          chain,
          statusCode: 200,
          warning: 'Maximum redirects reached'
        });
      }

      let parsedUrl;
      try {
        parsedUrl = new URL(currentUrl);
      } catch (e) {
        return reject(new Error(`Invalid URL: ${currentUrl}`));
      }

      const client = parsedUrl.protocol === 'https:' ? https : http;

      const options = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port,
        path: parsedUrl.pathname + parsedUrl.search,
        method: 'HEAD',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.5',
        },
        timeout: 10000,
      };

      const req = client.request(options, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
          let location = res.headers.location;
          if (!location) {
            return resolve({
              finalUrl: currentUrl,
              chain,
              statusCode: res.statusCode,
              warning: 'Redirect without Location header'
            });
          }

          // Handle relative URLs
          if (location.startsWith('/')) {
            location = `${parsedUrl.protocol}//${parsedUrl.host}${location}`;
          } else if (!location.startsWith('http')) {
            location = new URL(location, currentUrl).href;
          }

          chain.push(location);
          redirectCount++;
          follow(location);
        } else {
          resolve({
            finalUrl: currentUrl,
            chain,
            statusCode: res.statusCode,
          });
        }
      });

      req.on('error', (err) => {
        // If HEAD fails, try GET
        if (options.method === 'HEAD') {
          options.method = 'GET';
          const retryReq = client.request(options, (res) => {
            // Consume response data to free memory
            res.resume();

            if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
              let location = res.headers.location;
              if (!location) {
                return resolve({
                  finalUrl: currentUrl,
                  chain,
                  statusCode: res.statusCode,
                  warning: 'Redirect without Location header'
                });
              }

              if (location.startsWith('/')) {
                location = `${parsedUrl.protocol}//${parsedUrl.host}${location}`;
              } else if (!location.startsWith('http')) {
                location = new URL(location, currentUrl).href;
              }

              chain.push(location);
              redirectCount++;
              follow(location);
            } else {
              resolve({
                finalUrl: currentUrl,
                chain,
                statusCode: res.statusCode,
              });
            }
          });

          retryReq.on('error', (retryErr) => {
            reject(new Error(`Failed to resolve URL: ${retryErr.message}`));
          });

          retryReq.on('timeout', () => {
            retryReq.destroy();
            reject(new Error('Request timed out'));
          });

          retryReq.end();
        } else {
          reject(new Error(`Failed to resolve URL: ${err.message}`));
        }
      });

      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Request timed out'));
      });

      req.end();
    }

    follow(url);
  });
}

// API endpoint to resolve a shortened URL
app.post('/api/resolve', async (req, res) => {
  let { url } = req.body;

  if (!url) {
    return res.status(400).json({ error: 'URL is required' });
  }

  // Add protocol if missing
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    url = 'https://' + url;
  }

  try {
    const result = await resolveUrl(url);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Serve the frontend
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`\n🔗 Unshortener running at http://localhost:${PORT}\n`);
});
