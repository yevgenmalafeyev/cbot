# The bots' computer: a Linux desktop with Chrome and the Claude CLI.
# Everything the bots do happens in here; the control plane (Telegram tokens,
# secret store, links) lives in the separate `core` container.
FROM debian:bookworm

ENV DEBIAN_FRONTEND=noninteractive LANG=C.UTF-8 LC_ALL=C.UTF-8 TZ=Europe/Lisbon

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl wget gnupg sudo tini tzdata locales procps psmisc less nano vim-tiny \
      git ripgrep jq unzip zip xz-utils file openssh-client rsync build-essential python3 python3-pip python3-venv pipx \
      tigervnc-standalone-server tigervnc-tools dbus-x11 x11-utils x11-xserver-utils xauth \
      xfce4 xfce4-terminal mousepad ristretto thunar-archive-plugin \
      xdotool xclip maim imagemagick ffmpeg poppler-utils \
      fonts-noto-core fonts-noto-cjk fonts-noto-color-emoji fonts-liberation fonts-dejavu \
 && ln -fs /usr/share/zoneinfo/$TZ /etc/localtime \
 && rm -rf /var/lib/apt/lists/*

# Node 22 (boxd, the MCP server and the Claude CLI all run on it)
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
 && apt-get install -y --no-install-recommends nodejs \
 && rm -rf /var/lib/apt/lists/*

# Google Chrome (amd64 only)
RUN curl -fsSL https://dl.google.com/linux/linux_signing_key.pub | gpg --dearmor -o /usr/share/keyrings/google-chrome.gpg \
 && echo "deb [arch=amd64 signed-by=/usr/share/keyrings/google-chrome.gpg] https://dl.google.com/linux/chrome/deb/ stable main" > /etc/apt/sources.list.d/google-chrome.list \
 && apt-get update && apt-get install -y --no-install-recommends google-chrome-stable \
 && rm -rf /var/lib/apt/lists/* \
 && sed -i 's#^Exec=/usr/bin/google-chrome-stable#Exec=/usr/local/bin/chrome#' /usr/share/applications/google-chrome.desktop

RUN npm install -g @anthropic-ai/claude-code

# SVG renderer for the bots' profile pictures (kept as its own layer so adding it does not rebuild the desktop)
RUN apt-get update && apt-get install -y --no-install-recommends librsvg2-bin && rm -rf /var/lib/apt/lists/*

# The bots work as `bot` with passwordless sudo: root in practice, but the
# Claude CLI refuses --dangerously-skip-permissions when started as root.
RUN useradd -m -u 1000 -s /bin/bash bot \
 && echo 'bot ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/bot && chmod 440 /etc/sudoers.d/bot

COPY chrome-policy.json /etc/opt/chrome/policies/managed/cbot.json
COPY bin/ /usr/local/bin/
COPY boxd/ /opt/cbot/boxd/
COPY mcp/ /opt/cbot/mcp/
COPY skel/ /opt/cbot/skel/
RUN chmod +x /usr/local/bin/* \
 && cd /opt/cbot/mcp && npm install --omit=dev --no-audit --no-fund

ENV DISABLE_AUTOUPDATER=1
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/cbot-entrypoint"]
