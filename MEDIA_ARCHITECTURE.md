# ZenithMax V17.1 — Online Media Architecture

ZenithMax V17.1 intentionally ships **zero bundled demo MP4 files**.

### Video sources
1. **ZenithMax creator uploads** — users upload their own videos through the resumeable chunked-upload API. Those files belong in persistent media storage for production use.
2. **Online discovery URLs** — when `PEXELS_API_KEY` is configured, ZenithMax can query Pexels and render real online video URLs without copying the videos into the repository.

### Why this model
- Keeps GitHub and Render deployments small.
- Allows the online catalog to change without rebuilding ZenithMax.
- Separates creator-owned uploads from third-party licensed discovery content.

### Attribution and rights
Pexels media is labeled and linked to its source page. ZenithMax should only use external media in accordance with the provider's terms and licenses.

### Render environment
Set `PEXELS_API_KEY` in the **ZenithMax web service** Environment Variables. Never commit the key to GitHub or expose it in browser code.

### Production uploads
The repository's local `/uploads` path is suitable for development, but production should use durable persistent storage/object storage for user-uploaded media.
