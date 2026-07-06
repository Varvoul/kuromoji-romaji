# Kuromoji Romaji Converter

A Japanese-to-Romaji conversion API powered by [kuromoji.js](https://github.com/takuyaa/kuromoji.js) morphological analyzer.

## Architecture

```
Client → Cloudflare Worker (proxy) → Vercel API (kuromoji) → JSON response
```

- **Cloudflare Worker** (`worker/`): Lightweight proxy at `https://kuromoji-dict.bionmovies47.workers.dev/`
- **Vercel API** (`api/`): Node.js serverless function with kuromoji for accurate morphological analysis

## Endpoints

### Convert Japanese to Romaji
```
GET /convert?text=<URL-encoded Japanese text>
```

**Response:**
```json
{ "romaji": "konnichiha" }
```

**Errors:**
- `400` - Missing text parameter
- `500` - Conversion failed

### Health Check
```
GET /
```
Returns: `Romaji converter is running`

## How It Works

1. The Cloudflare Worker receives requests and proxies them to the Vercel API
2. The Vercel API uses kuromoji.js to perform morphological analysis of Japanese text
3. Kuromoji provides accurate readings (pronunciations) for each token, including kanji
4. Readings (in katakana) are converted to romaji using a comprehensive kana mapping
5. Special handling for small tsu (っ/ッ) produces correct consonant doubling (e.g., 学校 → gakkou)

## Local Development

```bash
npm install
# Test the API locally
vercel dev
```

## Deployment

- **Vercel**: Deployed via `vercel deploy --prod`
- **Cloudflare Worker**: Deployed via `wrangler deploy`