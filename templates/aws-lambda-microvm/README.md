# AWS Lambda MicroVM image for sandboxrouting

Lambda MicroVMs have no exec API: the only way into a running VM is its HTTPS endpoint,
which proxies to a port inside it. This image runs `execd.mjs`, a dependency-free server
on port 8080 that runs commands and moves files, so the router can treat a MicroVM like
any other sandbox.

1. Build and register the image as a MicroVM image (`aws lambda-microvms create-microvm-image`,
   from this Dockerfile). It must be ARM64.
2. Give the router its ARN and AWS credentials:

   ```dotenv
   LAMBDA_MICROVM_IMAGE=arn:aws:lambda:us-east-1:123456789012:microvm-image:sbr
   AWS_REGION=us-east-1        # plus the usual AWS credential chain
   ```

3. `sbr check --provider lambda-microvm`

Per-sandbox environment variables reach the VM through `runHookPayload`, which Lambda
delivers to the image's `/run` hook; execd applies them to every command.
