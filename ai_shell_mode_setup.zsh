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
    you_said=$(node "$_AI_SCRIPT_DIR/src/prompt.ts" "$@")
    if [[ -z "$you_said" ]]; then
        return 1
    fi
    echo "$you_said"
    ai "$you_said"
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

# ZLE widget to prefix the current buffer with ': ' (null command) and accept it
_ai_invoke_widget() {
    # Only prefix if the buffer doesn't already start with ': '
    if [[ -n "$BUFFER" && "$BUFFER" != \:\ * && "$BUFFER" != ":" ]]; then
        BUFFER=": $BUFFER"
        CURSOR=$#BUFFER
    fi
    _AI_NEXT_CMD_IS_AI=1
    zle accept-line
}
zle -N _ai_invoke_widget

# Bind Ctrl+Enter (CSI u format) to the one-off invoke widget
bindkey '\e[13;5u' _ai_invoke_widget

# --- AI Modal Behavior ---
_AI_MODE=0

# ZLE widget to toggle AI mode instantly via shortcut
_ai_toggle_widget() {
    if [[ "$_AI_MODE" -eq 1 ]]; then
        _AI_MODE=0
        if [[ -n "${_AI_SAVED_RPROMPT+x}" && "$RPROMPT" == *"[AI Mode]"* ]]; then
            RPROMPT="$_AI_SAVED_RPROMPT"
            unset _AI_SAVED_RPROMPT
        fi
        zle reset-prompt
        zle -R
        zle -M "🤖 Exited AI mode."
    else
        _AI_MODE=1
        if [[ "$RPROMPT" != *"[AI Mode]"* ]]; then
            _AI_SAVED_RPROMPT="$RPROMPT"
            RPROMPT="%F{cyan}[AI Mode]%f $RPROMPT"
        fi
        zle reset-prompt
        zle -R
        zle -M "Entered AI mode. All inputs will be sent to AI!"
    fi
}
zle -N _ai_toggle_widget

# Bind Ctrl+x ENTER to toggle AI mode
bindkey '^X^M' _ai_toggle_widget
bindkey '^X^J' _ai_toggle_widget

# Safely wrap accept-line to intercept inputs
if [[ -z "$_AI_ACCEPT_LINE_WRAPPED" ]]; then
    _AI_ACCEPT_LINE_WRAPPED=1

    # Save the original accept-line widget to avoid breaking other plugins
    zle -A accept-line _ai_saved_accept_line

    _ai_mode_accept_line() {
        if [[ "$_AI_MODE" -eq 1 && -n "$BUFFER" ]]; then
            # Intercept commands to exit out of AI mode
            if [[ "$BUFFER" == "exit" || "$BUFFER" == "quit" ]]; then
                _AI_MODE=0
                # Clear buffer so we don't execute "quit" in the shell
                BUFFER=""
                echo -e "\n🤖 Exited AI mode."
                zle _ai_saved_accept_line
                return
            fi

            # Prefix the current command with ': ' (null command)
            if [[ "$BUFFER" != \:\ * && "$BUFFER" != ":" ]]; then
                BUFFER=": $BUFFER"
                CURSOR=$#BUFFER
            fi
            _AI_NEXT_CMD_IS_AI=1
        fi

        # Proceed with executing the line
        zle _ai_saved_accept_line
    }
    zle -N accept-line _ai_mode_accept_line

    _ai_alt_accept_line() {
        if [[ "$_AI_MODE" -eq 1 ]]; then
            # In AI mode, Alt+Enter acts as standard shell mode
            zle _ai_saved_accept_line
        else
            # In standard mode, Alt+Enter acts as AI mode
            if [[ -n "$BUFFER" ]]; then
                if [[ "$BUFFER" != \:\ * && "$BUFFER" != ":" ]]; then
                    BUFFER=": $BUFFER"
                    CURSOR=$#BUFFER
                fi
                _AI_NEXT_CMD_IS_AI=1
            fi
            zle _ai_saved_accept_line
        fi
    }
    zle -N _ai_alt_accept_line

    # Bind Alt+Enter to the alternate accept line widget
    bindkey '\e\r' _ai_alt_accept_line
    bindkey '^[^M' _ai_alt_accept_line
fi

# Visual indicator in the right prompt (RPROMPT)
_ai_precmd_prompt_indicator() {
    _AI_NEXT_CMD_IS_AI=0
    if [[ "$_AI_MODE" -eq 1 ]]; then
        if [[ "$RPROMPT" != *"[AI Mode]"* ]]; then
            _AI_SAVED_RPROMPT="$RPROMPT"
            RPROMPT="%F{cyan}[AI Mode]%f $RPROMPT"
        fi
    else
        if [[ -n "${_AI_SAVED_RPROMPT+x}" && "$RPROMPT" == *"[AI Mode]"* ]]; then
            RPROMPT="$_AI_SAVED_RPROMPT"
            unset _AI_SAVED_RPROMPT
        fi
    fi
}

# Hook to execute AI command just before shell executes the null command
_ai_preexec_hook() {
    if [[ "$_AI_NEXT_CMD_IS_AI" -eq 1 ]]; then
        _AI_NEXT_CMD_IS_AI=0
        # Command is prefixed with ": ", extract the prompt and send to AI
        ai "${1#*: }"
    fi
}

autoload -Uz add-zsh-hook
add-zsh-hook precmd _ai_precmd_prompt_indicator
add-zsh-hook preexec _ai_preexec_hook
