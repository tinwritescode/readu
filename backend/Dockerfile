FROM golang:1.26-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY *.go openapi.json ./
COPY migrations ./migrations
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/vtts-backend .

FROM alpine:3.21
# CA certificates are needed for HTTPS calls to Resend.
RUN apk add --no-cache ca-certificates
COPY --from=build /out/vtts-backend /usr/local/bin/vtts-backend
ENV PORT=8080 CACHE_DIR=/tmp/cache
EXPOSE 8080
CMD ["vtts-backend"]
