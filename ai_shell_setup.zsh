# ai_shell_setup.zsh — Source this in your interactive zsh session.
# Sets up a background AI agent connected via named pipes.
# Usage: source ai_shell_setup.zsh
#        ai hello world

_AI_SCRIPT_DIR="${0:A:h}"
_AI_PIPE_IN="/tmp/ai_pipe_in.$$"
_AI_PIPE_OUT="/tmp/ai_pipe_out.$$"

# Create named pipes
mkfifo "$_AI_PIPE_IN" "$_AI_PIPE_OUT"

# Start agent in background. Disabling monitor mode (+m) prevents creating a new
# process group. This allows the agent to read from /dev/tty without SIGTTIN!
set +m
node "$_AI_SCRIPT_DIR/src/agent.ts" < "$_AI_PIPE_IN" > "$_AI_PIPE_OUT" &
_AI_AGENT_PID=$!
set -m

# Open persistent file descriptors (order matters to avoid deadlock)
exec 3>"$_AI_PIPE_IN"   # unblocks agent's stdin
exec 4<"$_AI_PIPE_OUT"  # unblocks agent's stdout

aiui() {
    you_said=$(node "$_AI_SCRIPT_DIR/src/stt.ts" "$@")
    if [[ -z "$you_said" ]]; then
        return 1
    fi
    echo "$you_said"
    ai "$you_said"
}

airepl() {
    echo "AI Shell. Type 'exit' to quit."
    local line
    while vared -eh -p "ai > " -c line; do
        if [[ "$line" == "exit" ]]; then
            break
        fi
        if [[ "$line" == "clear" ]]; then
            clear
            line=""
            continue
        fi
        if [[ -n "$line" ]]; then
            # remove leading : if present
            line=${line#: }
            print -s ": $line"
        fi
        if [[ -n "$line" ]]; then
            ai "$line"
        fi
        line=""
    done
}

ai() {
    # Capture the last command's exit code and text BEFORE running anything else
    local last_status=$?
    local last_cmd=$(fc -ln -1 2>/dev/null | xargs 2>/dev/null || echo "N/A")

    # No args
    if [[ $# -eq 0 ]]; then
        # STDIN is tty
        if [[ -t 0 ]]; then
          echo "Usage: ai <prompt>"
          return 1
        fi
    fi

    # Send fixed context only once per session
    if [[ -z "$_AI_FIXED_CONTEXT_SENT" ]]; then
        echo "OS: $(uname -s 2>/dev/null || echo Unknown) $(uname -m 2>/dev/null || echo Unknown)" >&3
        echo "Shell: $SHELL" >&3
        echo "User: $USER" >&3
        echo "Current Time: $(date 2>/dev/null || echo Unknown)" >&3
        echo "Preferred Editor: ${VISUAL:-${EDITOR:-vi}}" >&3
        if command -v node >/dev/null 2>&1; then echo "Node version: $(node -v)" >&3; fi
        _AI_FIXED_CONTEXT_SENT=1
    fi

    # Send dynamic context with every prompt
    echo "Current directory: ${PWD}" >&3

    # Send Git context safely
    if command -v git >/dev/null 2>&1 && git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
        local git_status="Clean"
        if ! git diff --quiet 2>/dev/null || ! git diff --cached --quiet 2>/dev/null; then
            git_status="Dirty (uncommitted changes)"
        fi
        echo "Git State: Branch '$(git branch --show-current 2>/dev/null)' - $git_status" >&3
    fi

    # Send Python Virtual Environment context safely
    if [[ -n "$VIRTUAL_ENV" ]]; then
        echo "Active Python Venv: ${VIRTUAL_ENV##*/}" >&3
    fi

    # Send last command context
    echo "Last command run: $last_cmd" >&3
    echo "Last exit code: $last_status" >&3

    echo "---" >&3
    echo "$*" >&3
    [[ ! -t 0 ]] && cat >&3
    echo "__END_OF_PROMPT__" >&3

    # Show indicator while waiting for response
    if zmodload zsh/zselect 2>/dev/null; then
        printf "\r⏳"
        # Wait for data to become available on FD 4
        zselect -r 4 2>/dev/null
        printf "\r\e[K" # Clear line and show cursor
    fi

    while IFS= read -r line <&4; do
        [[ "$line" == "__AI_EOF__" ]] && break
        echo "$line"
    done
}

_ai_cleanup() {
    exec 3>&- 2>/dev/null   # close write fd
    exec 4<&- 2>/dev/null   # close read fd
    kill "$_AI_AGENT_PID" 2>/dev/null
    wait "$_AI_AGENT_PID" 2>/dev/null
    rm -f "$_AI_PIPE_IN" "$_AI_PIPE_OUT"
}

trap '_ai_cleanup' EXIT
