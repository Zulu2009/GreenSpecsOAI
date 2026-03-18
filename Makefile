PYTHON ?= python3
YKO_SCRIPT = yko_local_intel/scripts/yko_staging_db.py
YKO_DB = yko_local_intel/data/yko_staging.sqlite
YKO_BRANDS_CSV = yko_local_intel/data/brands.csv
YKO_JSON_OUT = yko_local_intel/json_snapshots/yko_snapshot.json
YKO_SQL_OUT = yko_local_intel/sql_exports/yko_inserts.sql

.PHONY: yko-init yko-import-brands yko-add-claim yko-add-evidence yko-export-json yko-export-sql

yko-init:
	$(PYTHON) $(YKO_SCRIPT) --db $(YKO_DB) init-db

yko-import-brands:
	$(PYTHON) $(YKO_SCRIPT) --db $(YKO_DB) import-brands --csv $(YKO_BRANDS_CSV)

yko-add-claim:
	@echo "Usage: make yko-add-claim BRAND='Clover Sonoma' TEXT='Claim text' [STATUS=pending SOURCE='optional']"
	$(PYTHON) $(YKO_SCRIPT) --db $(YKO_DB) add-claim --brand "$(BRAND)" --text "$(TEXT)" --status "$(or $(STATUS),pending)" --source "$(SOURCE)"

yko-add-evidence:
	@echo "Usage: make yko-add-evidence CLAIM_ID=1 TEXT='Evidence text' [TYPE=document SOURCE_URL='https://...']"
	$(PYTHON) $(YKO_SCRIPT) --db $(YKO_DB) add-evidence --claim-id "$(CLAIM_ID)" --text "$(TEXT)" --type "$(or $(TYPE),document)" --source-url "$(SOURCE_URL)"

yko-export-json:
	$(PYTHON) $(YKO_SCRIPT) --db $(YKO_DB) export-json --out $(YKO_JSON_OUT)

yko-export-sql:
	$(PYTHON) $(YKO_SCRIPT) --db $(YKO_DB) export-sql --out $(YKO_SQL_OUT)
