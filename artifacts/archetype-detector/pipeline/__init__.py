"""
ETL-пайплайн для сбора, хранения и анализа исторических данных CoinGlass.

Модули:
  cg_client   — HTTP-клиент CoinGlass v4 с ротацией 5 ключей
  duckdb_store — инициализация DuckDB и batch-вставки
  analyzer    — поиск паттернов с WR 80%+ перед «пампами»
"""
