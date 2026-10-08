#!/bin/bash
# Quick git init + first commit for the sitting_duc project
# Run from project root: ./git-init.sh

set -e

echo "Initializing git..."
git init

echo "Adding all files..."
git add .

echo "First commit..."
git commit -m "Saigon, 5am — initial commit

- Static one-page site for YouTube channel
- Three.js hero (phin drip, rain, scooter trails, Saigon skyline)
- Procedural Web Audio (rain + hum + pad)
- Self-hosted fonts, inline critical CSS, lazy three.js
- Procedural SVG thumbnails, no stock photos
- Respects reduced-motion, lazy audio, scroll-gated hero
- 33 files, 2 MB deployable"

echo ""
echo "Done. Next:"
echo "  1. Edit js/config.js with your 6 URLs"
echo "  2. git remote add origin <your-repo-url>"
echo "  3. git push -u origin main"
echo "  4. Deploy: drag folder to netlify.com/drop"