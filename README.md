# Shopify → javni cjenik (CSV) + arhiva

GitHub svaki sat pokrene `generate.mjs`, koji pročita Shopify i objavi na GitHub Pages:

| Adresa | Sadržaj |
|---|---|
| `https://cjenik.tvojshop.hr/` | stranica „Cjenik proizvoda“: zadnje ažuriranje, preuzimanje, arhiva |
| `https://cjenik.tvojshop.hr/cjenik.csv` | aktualni cjenik, stalni URL |
| `https://cjenik.tvojshop.hr/arhiva/cjenik_2026-10-01_0805.csv` | snimka pri svakoj promjeni (cijena, dostupnost, novi artikl), čuva se 35 dana |

Besplatno: treba samo GitHub račun. Repozitorij mora biti **javni** (GitHub Pages je na
besplatnom planu samo za javne). U repozitoriju nema nikakvih tajni, jer ključevi idu u *Secrets*.

---

## 1. Shopify app (samo čitanje)

1. Otvori **dev.shopify.com** → *Apps* → *Create app* → naziv „Cjenik CSV“.
2. *Versions / Configuration* → Access scopes: `read_products`, `read_inventory` → *Release*.
3. *Home* → *Install app* → odaberi svoj shop.
4. *Settings* → kopiraj **Client ID** i **Client secret**.

## 2. GitHub repozitorij

1. Na github.com → *New repository* → naziv npr. `cjenik` → **Public** → *Create*.
2. Učitaj sadržaj ove mape (*uploading an existing file*: povuci sve datoteke i mapu `.github`),
   ili preko gita:
   ```
   git remote add origin https://github.com/KORISNIK/cjenik.git
   git push -u origin main
   ```

## 3. Postavke repozitorija

*Settings → Secrets and variables → Actions*

**Secrets** (tab *Secrets*, *New repository secret*):

| Naziv | Vrijednost |
|---|---|
| `SHOPIFY_SHOP` | `tvojshop.myshopify.com` |
| `SHOPIFY_CLIENT_ID` | iz koraka 1 |
| `SHOPIFY_CLIENT_SECRET` | iz koraka 1 |

**Variables** (tab *Variables*):

| Naziv | Vrijednost |
|---|---|
| `SHOP_NAME` | npr. `Moj Shop d.o.o.` |
| `PAGES_DOMAIN` | `cjenik.tvojshop.hr` |
| `PUBLIC_URL` | `https://cjenik.tvojshop.hr` |

## 4. Prvo pokretanje

*Actions* → **Cjenik** → *Run workflow*. Nakon ~1 minute mora biti zeleno ✅.
Ako je crveno, otvori run i pogledaj poruku `GREŠKA: ...`.

## 5. GitHub Pages

*Settings → Pages* → Source: **Deploy from a branch** → Branch: **gh-pages** / `(root)` → *Save*.
U polje *Custom domain* upiši `cjenik.tvojshop.hr`, a kad se DNS provjeri, uključi **Enforce HTTPS**.

## 6. DNS (kod registrara domene)

Dodaj zapis: **CNAME** `cjenik` → `KORISNIK.github.io`

Shopify i glavna domena shopa ostaju netaknuti.

## 7. Footer u Shopifyju

*Online Store → Navigation → Footer menu → Add menu item*:
naziv **Cjenik proizvoda**, link `https://cjenik.tvojshop.hr/`

---

## Kako radi arhiva

- `cjenik.csv` se osvježava svaki sat.
- Kad se sadržaj razlikuje od zadnje arhivirane verzije, sprema se nova datoteka u `arhiva/`
  s datumom i vremenom. Iz arhive se tako vidi točno kad se promijenila cijena ili dostupnost.
- Datoteke starije od 35 dana brišu se automatski.
- `.state/history.json` čuva cijene za „najnižu cijenu u posljednjih 30 dana“ (nije javno dostupan).

## Napomene

- GitHub može gasiti zakazane workflowe u repozitoriju bez aktivnosti 60 dana. Ovdje se
  objavljuje svaki sat, pa se to ne bi trebalo dogoditi. Ipak, jednom mjesečno baci pogled na *Actions*.
- Kolone se mijenjaju u nizu `COLUMNS` na vrhu `generate.mjs`.

## Lokalni test bez Shopifyja

```powershell
$env:MOCK_FILE="mock.json"; $env:OUTPUT_DIR="./public"; node generate.mjs
```

## Alternativa: vlastiti server

Ako se kasnije prebaciš na svoj server: `deploy/nginx-cjenik.conf` + `deploy/crontab.txt`,
a konfiguracija ide u `.env` (predložak `.env.example`).
