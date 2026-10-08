FROM python:3.12-slim

# serve.py serves its working directory, so run it from inside the app folder
# to put the tester at "/" instead of "/ferbos-pcb-testing/".
COPY serve.py /srv/serve.py
COPY ferbos-pcb-testing /srv/app
WORKDIR /srv/app

USER nobody
EXPOSE 8080
CMD ["python3", "-u", "/srv/serve.py", "--bind", "0.0.0.0", "--port", "8080"]
