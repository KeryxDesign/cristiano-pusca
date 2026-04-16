#!/bin/bash
export PATH="/usr/local/bin:$PATH"
cd /Users/davidefilippini/Documents/Claude/cristiano-pusca
exec node node_modules/astro/bin/astro.mjs dev --port 4325
