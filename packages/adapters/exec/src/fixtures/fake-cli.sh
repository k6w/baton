#!/bin/sh
# Fake prompt-taking CLI: reports whether it has a TTY, prints colored output and fixes a typo.
if [ -t 1 ]; then echo "tty: yes"; else echo "tty: no"; fi
printf '\033[32mtask: %s\033[0m\n' "$1"
printf 'thinking 10%%\rthinking 100%%\n'
sed -i.bak 's/teh/the/' notes.txt 2>/dev/null && rm -f notes.txt.bak
echo done
