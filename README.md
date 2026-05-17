# PhotoEdit Pro

Портретный редактор в браузере (MediaPipe Face Landmarker). Статика, без сборки.

## Уже развёрнуто

| Где | URL |
|-----|-----|
| Репозиторий | https://github.com/Pshenovich/photoedit-portrait |
| **Vercel** (основной прод) | https://photoedit-portrait.vercel.app |
| **GitHub Pages** (зеркало) | https://pshenovich.github.io/photoedit-portrait/ |

Оба варианта отдают тот же `index.html` по HTTPS.

## Авто-деплой Vercel (прод)

Каждый **`git push` в `main`** запускает GitHub Actions [`.github/workflows/deploy-production.yml`](.github/workflows/deploy-production.yml) и выкладывает на **https://photoedit-portrait.vercel.app**.

Секреты в репозитории: `VERCEL_TOKEN`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID`.

Ручной прод с машины (если CI не нужен):

```bash
./scripts/deploy-prod.sh
```

Или вручную:

```bash
NPM_CONFIG_CACHE=/tmp/npm-cache-photoedit npx vercel@latest deploy --prod --yes
```

Проект Vercel: `knazorlov-6551s-projects/photoedit-portrait` (аккаунт CLI на этой машине).

## GitHub Pages

Страницы включены с ветки `main`, путь `/`. Обновление после push может занять 1–2 минуты.

## Локально

```bash
python3 -m http.server 8080
```

Для **ИИ-ретуши** нужен деплой на Vercel (или `vercel dev`), а не чистая статика: `api/comet-edit.js` вызывает **OpenRouter**, при ошибке — **CometAPI**.

1. **Vercel → Settings → Environment Variables:**
   - `OPENROUTER_API_KEY` — основной ключ с [OpenRouter](https://openrouter.ai/keys)
   - `COMET_API_KEY` — запасной с [CometAPI](https://apidoc.cometapi.com) (опционально, но рекомендуется для масок / удаления человека)
   - `OPENROUTER_IMAGE_MODEL` — необязательно (по умолчанию `google/gemini-2.5-flash-image`)
2. Локально: `vercel dev` и те же переменные в `.env`.

Диагностика: `GET /api/comet-env-check` на деплое Vercel.

Без ключей пресеты «ИИ тюн» вернут ошибку о настройке API.

## Заметки

- Первый визит тянет WASM/модель MediaPipe из сети.
- Выбор фото с устройства — только по **HTTPS** или `localhost` (продакшен это удовлетворяет).
