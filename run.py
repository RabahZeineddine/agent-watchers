import os
import sys
import argparse
import yaml
import time
from core.state_store import StateStore
from watchers.pr_reviewer.watcher import PRReviewerWatcher

def load_config(config_path: str = "config.yaml") -> dict:
    if not os.path.exists(config_path):
        base_dir = os.path.dirname(os.path.abspath(__file__))
        config_path = os.path.join(base_dir, config_path)
    with open(config_path, "r", encoding="utf-8") as f:
        return yaml.safe_load(f)

def run_watchers(config: dict, dry_run: bool = False, once: bool = True):
    state_store = StateStore(config.get("storage", {}).get("db_path", "data/watchers.db"))
    
    # Registro de watchers disponíveis
    watchers_to_run = []
    
    if config.get("watchers", {}).get("pr_reviewer", {}).get("enabled", True):
        watchers_to_run.append(("pr_reviewer", PRReviewerWatcher(config, state_store)))

    interval_minutes = config.get("watchers", {}).get("pr_reviewer", {}).get("interval_minutes", 30)

    while True:
        print(f"\n[{time.strftime('%Y-%m-%d %H:%M:%S')}] Iniciando ciclo de monitoramento...")
        for name, watcher in watchers_to_run:
            try:
                print(f"-> Executando watcher: {name}")
                results = watcher.run(dry_run=dry_run)
                state_store.record_run(name, "SUCCESS", f"Processou {len(results)} itens")
            except Exception as e:
                print(f"Erro no watcher {name}: {e}")
                state_store.record_run(name, "ERROR", str(e))

        if once:
            print("Execução única concluída.")
            break

        print(f"Aguardando {interval_minutes} minutos para a próxima checagem...")
        time.sleep(interval_minutes * 60)

def main():
    parser = argparse.ArgumentParser(description="Agent Watchers Orchestrator")
    parser.add_argument("--dry-run", action="store_true", help="Executa a análise com IA mas não posta no GitHub nem altera Slack")
    parser.add_argument("--daemon", action="store_true", help="Roda em loop contínuo a cada intervalo configurado")
    parser.add_argument("--config", default="config.yaml", help="Caminho do arquivo de configuração")
    args = parser.parse_args()

    cfg = load_config(args.config)
    run_watchers(cfg, dry_run=args.dry_run, once=not args.daemon)

if __name__ == "__main__":
    main()
