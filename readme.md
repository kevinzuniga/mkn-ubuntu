## para copiar los archivos a ec2
rsync -avz \
  -e "ssh -i mknkeypair.pem" \
  --exclude='.git' \
  ./mkn-ubuntu \
  ubuntu@44.201.195.240:/home/ubuntu/

## para eliminar la ejecucion
sudo docker ps
sudo docker stop ID/NAME
sudo docker rm ID/NAME

## para construir
sudo docker build -t mkn-app .
docker build --no-cache -t mkn-app .

## para correr
sudo docker run -d -p 80:3000 --env-file .env --name mkn mkn-app

## para los logs
sudo docker logs -f mkn
sudo docker ps
sudo docker logs ID/NAME


## install docker
sudo apt-get update
sudo apt-get install -y ca-certificates curl gnupg

## Agrega la clave GPG oficial de Docker
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
  | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
sudo chmod a+r /etc/apt/keyrings/docker.gpg

## Agrega el repositorio de Docker (para Ubuntu Noble 24.04)
echo \
  "deb [arch=$(dpkg --print-architecture) \
  signed-by=/etc/apt/keyrings/docker.gpg] \
  https://download.docker.com/linux/ubuntu \
  $(lsb_release -cs) stable" | \
  sudo tee /etc/apt/sources.list.d/docker.list > /dev/null

## Instala Docker Engine
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

## Verifica que Docker está instalado
docker --version

## (Opcional) Permitir usar Docker sin sudo
sudo usermod -aG docker $USER
newgrp docker




# borra contenedores / imágenes previas si quieres
sudo docker container prune -f
sudo docker image prune -f

# reconstruye sin cache para que realmente baje Node 20
sudo docker build --no-cache -t mkn-app .

# lanza el contenedor
sudo docker run -d -p 80:3000 --env-file .env --name mkn mkn-app
sudo docker logs -f mkn