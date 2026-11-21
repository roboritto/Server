This is basically a website version of the [movie database](https://github.com/roboritto/MovieDatabase). It uses tailscale to connect devices to the server. This service is similar to plex though you don’t necessarily need to have the file on the computer, though that’s possible too. You can visit https://roboritto.github.io/Server/ to see how the website function before downloading. Note that certain features won’t be available since it needs your tmdb api key or have other dependencies. 

you should obtain your tmdb api key before following this guide. 

How to setup the server:
1. go to tailscale.com and download the latest release then follow the instructions from the download page. 
2. once you have tailscale setup and connected, copy the device’s ip address, you’ll need this later. 
3. make sure you have installed python and added it to PATH and any coding software that you’re familiar with.
4. clone the repository.
5. install all required packages by running “pip install -r requirements.txt” in the terminal. 
6. once the packages are done installing, open .env.example and rename it to .env. inside the file you should place your tmdb_api_key and setup a password for your website in the api_token_key if you want, if not just leave it blank.
7. you can start the server by typing “uvicorn main:app —host 100.x.x.x —port 8000” into the terminal. 
8. try accessing the website by typing “http://100.x.x.x:8000/“ in your browser. you can change the 100.x.x.x to anything you want by changing your device’s name in tailscale.
9. once the website is up and running, you can delete the demo_movies.json. Now you can delete or add any movie you like.
10. if you want to access the website from other devices like your phone makes sure you have tailscale installed and connected to the same account as the server. you can’t reach your website if your devices is not connected to tailscale. 

Optional Steps:  
Custom Movies  
11. if there is a movie that is not on the tmdb, you can add it by pressing the add button and typing in numbers >80000.  
12. you can fill in the movie info like the name, year, and more in the custom_movies.json.  

Website sharing  
13. if you are sharing this website with other people, just repeat step 10.  
14. you can also block other ip from seeing a specific movie by adding their ip address and the movie id in hidden_movies.json.  
15. these other ips would also be blocked from doing some actions like deleting movies.  

