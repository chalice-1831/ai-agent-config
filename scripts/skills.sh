#!/usr/bin/env bash

# Refresh the global skills index before installing pinned favorites.
npx skills update -g -y

# Core discovery skill used to find and manage additional skills.
npx skills add --agent opencode -g https://github.com/vercel-labs/skills --skill find-skills -y

# Design documentation.
npx skills add --agent opencode -g https://github.com/mattpocock/skills --skill grill-me -y
npx skills add --agent opencode -g https://github.com/mattpocock/skills --skill grill-with-docs -y
npx skills add --agent opencode -g https://github.com/mattpocock/skills --skill grilling -y
npx skills add --agent opencode -g https://github.com/mattpocock/skills --skill handoff -y
npx skills add --agent opencode -g https://github.com/mattpocock/skills --skill domain-modeling -y
npx skills add --agent opencode -g https://github.com/spillwavesolutions/design-doc-mermaid --skill design-doc-mermaid -y

# Workflow and architecture helpers.
npx skills add --agent opencode -g https://github.com/mattpocock/skills --skill improve-codebase-architecture -y
npx skills add --agent opencode -g https://github.com/github/awesome-copilot --skill refactor -y

# Personal or project-specific skills.
npx skills add --agent opencode -g https://github.com/infituit/skills -y
npx skills add --agent opencode -g https://github.com/zouxingyuks/ai-agent-config -y

# Language-specific skill packs.
## Go
npx skills add --agent opencode -g https://github.com/samber/cc-skills-golang -y

## Python
npx skills add --agent opencode -g https://github.com/wshobson/agents --skill python-design-patterns -y

## Cli Docs
npx skills add --agent opencode -g https://github.com/cli/cli/tree/trunk --skill gh -y
npx skills add --agent opencode -g https://github.com/microsoft/playwright-cli --skill playwright-cli -y

# Show the final global skill set for OpenCode.
npx skills ls --agent opencode -g -y

# MongoDB

gh skill install --scope user --agent opencode https://github.com/mongodb/agent-skills mongodb-schema-design -y
gh skill install --scope user --agent opencode https://github.com/mongodb/agent-skills mongodb-connection -y
gh skill install --scope user --agent opencode https://github.com/mongodb/agent-skills mongodb-query-optimizer -y

# Redis
gh skill install --scope user --agent opencode https://github.com/redis/agent-skills redis-connections -y
gh skill install --scope user --agent opencode https://github.com/redis/agent-skills redis-clustering -y
gh skill install --scope user --agent opencode https://github.com/redis/agent-skills redis-core -y
gh skill install --scope user --agent opencode https://github.com/redis/agent-skills redis-search -y

npx skills add --agent opencode -g https://github.com/kepano/obsidian-skills.git -y

npx skills add --agent opencode -g https://github.com/grafana/gcx.git -y

npx skills add --agent opencode -g rohitg00/agentmemory -y