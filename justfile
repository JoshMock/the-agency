build:
  podman compose build

start: build
  podman compose up -d
  podman compose exec omp omp

restart: stop start

check-gpu:
  podman compose exec vllm nvidia-smi -L

ps:
  podman compose ps

status: ps check-gpu

stop:
  podman compose stop

destroy:
  podman compose down
