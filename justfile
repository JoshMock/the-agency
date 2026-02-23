[doc('Build all containers defined in the compose file')]
build:
  podman compose build

[doc('Start coding agent containers, plus local coding model in vLLM if there is an Nvidia GPU')]
start: build
  @if command -v nvidia-smi &> /dev/null || podman run --rm --runtime=nvidia alpine echo &> /dev/null 2>&1; then \
    podman compose up -d; \
  else \
    podman compose up -d omp mcp-docs; \
  fi
  podman compose exec omp omp

[doc('Stop and restart all services')]
restart: stop start

[doc('Check GPU availability in the vLLM container')]
check-gpu:
  podman compose exec vllm nvidia-smi -L

[doc('Display running containers')]
ps:
  podman compose ps

[doc('Show running containers and GPU status')]
status: ps check-gpu

[doc('Stop all running containers')]
stop:
  podman compose stop

[doc('Remove all containers and volumes')]
destroy:
  podman compose down
