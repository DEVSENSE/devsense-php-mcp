# update dependencies to latest version


npm i devsense-php-ls-node@latest
npm i devsense-php-ls@latest

# update package.json version number to match the latest installed versions of devsense-php-ls-node and devsense-php-ls
npm version $(npm show devsense-php-ls version) --no-git-tag-version