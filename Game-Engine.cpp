#include <glad/glad.h>
#include <GLFW/glfw3.h>

#include <iostream>

void framebuffer_size_callback(GLFWwindow* window, int width, int height);
void processInput(GLFWwindow* window);
const char* vertexShaderSource = "#version 330 core\n"
"layout (location = 0) in vec3 aPos;\n"
"void main()\n"
"{\n"
"   gl_Position = vec4(aPos.x, aPos.y, aPos.z, 1.0);\n"
"}\0";

const char* fragmentShaderSource = "#version 330 core\n"
"out vec4 FragColor;\n"
"void main()\n"
"{\n"
"   FragColor = vec4(1.0f, 0.5f, 0.2f, 1.0f);\n"
"}\0";


// settings
const unsigned int SCR_WIDTH = 800;
const unsigned int SCR_HEIGHT = 600;

int main()
{
    glfwInit();
    glfwWindowHint(GLFW_CONTEXT_VERSION_MAJOR, 3);
    glfwWindowHint(GLFW_CONTEXT_VERSION_MINOR, 3);
    glfwWindowHint(GLFW_OPENGL_PROFILE, GLFW_OPENGL_CORE_PROFILE);


    GLFWwindow* window = glfwCreateWindow(SCR_WIDTH, SCR_HEIGHT, "LearnOpenGL", NULL, NULL);
    if (window == NULL)
    {
        std::cout << "Failed to create GLFW window" << std::endl;
        glfwTerminate();
        return -1;
    }
    glfwMakeContextCurrent(window);
    glfwSetFramebufferSizeCallback(window, framebuffer_size_callback);


    if (!gladLoadGLLoader((GLADloadproc)glfwGetProcAddress))
    {
        std::cout << "Failed to initialize GLAD" << std::endl;
        return -1;
    }

    // --- draw a triangle ---
    // WRITE THE VERTEX SHADER
    // int to hold reference to shader
    unsigned int vertexShader;
    // create a shader for the vertex shader type
    vertexShader = glCreateShader(GL_VERTEX_SHADER);
    // assign ref to source code and lines of code to our shader reference
    glShaderSource(vertexShader, 1, &vertexShaderSource, NULL);
    // compile the shader dynamically at runtime
    glCompileShader(vertexShader);
    // check if vertex shader compiled
    int success;
    char infoLog[512];
    glGetShaderiv(vertexShader, GL_COMPILE_STATUS, &success);
    if (!success) {
        glGetShaderInfoLog(vertexShader, 512, NULL, infoLog);
        std::cout << "ERROR::SHADER::VERTEX::COMPILATION_FAILED\n" << infoLog << std::endl;
    }

    // WRITE THE FRAGMENT SHADER
    unsigned int fragmentShader;
    // create a shader for frag shader
    fragmentShader = glCreateShader(GL_FRAGMENT_SHADER);
    // asign refs to shader source
    glShaderSource(fragmentShader, 1, &fragmentShaderSource, NULL);
    // compile at runtime
    glCompileShader(fragmentShader);
    // error check
    glGetShaderiv(fragmentShader, GL_COMPILE_STATUS, &success);
    if (!success) {
        glGetShaderInfoLog(fragmentShader, 512, NULL, infoLog);
        std::cout << "ERROR::FRAGMENT::VERTEX::COMPILATION_FAILED\n" << infoLog << std::endl;
    }

    // SHADER PROGRAM   
    unsigned int shaderProgram;
    // get ID for program creation like VBO
    shaderProgram = glCreateProgram();
    // attach the vertex and fragment shaders to program and link them all
    glAttachShader(shaderProgram, vertexShader);
    glAttachShader(shaderProgram, fragmentShader);
    glLinkProgram(shaderProgram);
    // error check
    glGetProgramiv(shaderProgram, GL_LINK_STATUS, &success);
    if (!success) {
        glGetProgramInfoLog(shaderProgram, 512, NULL, infoLog);
        std::cout << "ERROR::SHADER::PROGRAM::LINKING_FAILED\n" << infoLog << std::endl;
    }
    // DELETE SHADER PROGRAMS FOR MEM
    glDeleteShader(vertexShader);
    glDeleteShader(fragmentShader);

    // triangles coordinates
    float vertices[] = {
    -0.5f, -0.5f, 0.0f,
     0.5f, -0.5f, 0.0f,
     0.0f,  0.5f, 0.0f
    };

    // STORE VERTICES IN GPU BUFFER
    // vertex buffer (store buffer [triangle] on GPU for quick use)
    unsigned int VBO, VAO;
    // assign VBO AND VAO id for the GPU
    glGenBuffers(1, &VBO);
    glGenVertexArrays(1, &VAO);
    // bind VBO AND VAO together
    glBindVertexArray(VAO);
    // bind array buffer to VBO
    glBindBuffer(GL_ARRAY_BUFFER, VBO);
    // bind buffer to vertices (which is configurable via VBO)
    glBufferData(GL_ARRAY_BUFFER, sizeof(vertices), vertices, GL_STATIC_DRAW);

    // TELL OPENGL HOW TO PROCESS VERTEX DATA
    // location of vertex attr (set in vertex shader), size of vertex, type, whether its int/byte, stride size (each vec3 has 3 floats), void ptr for offset
    glVertexAttribPointer(0, 3, GL_FLOAT, GL_FALSE, 3 * sizeof(float), (void*)0);
    // now enable the vertex attr at location 0
    glEnableVertexAttribArray(0);

    // unbind VBO and unlink VAO
    glBindBuffer(GL_ARRAY_BUFFER, 0);
    glBindVertexArray(0);



    



    while (!glfwWindowShouldClose(window))
    {
        processInput(window);

        glClearColor(0.2f, 0.3f, 0.3f, 1.0f);
        glClear(GL_COLOR_BUFFER_BIT);

        // now use created program
        glUseProgram(shaderProgram);
        // bind to VAO
        glBindVertexArray(VAO);
        // draw triangle
        glDrawArrays(GL_TRIANGLES, 0, 3);

        glfwSwapBuffers(window);
        glfwPollEvents();
    }

    // deallocate mem
    glDeleteVertexArrays(1, &VAO);
    glDeleteBuffers(1, &VBO);
    glDeleteProgram(shaderProgram);



    glfwTerminate();
    return 0;
}

void processInput(GLFWwindow* window)
{
    if (glfwGetKey(window, GLFW_KEY_ESCAPE) == GLFW_PRESS)
        glfwSetWindowShouldClose(window, true);
}


void framebuffer_size_callback(GLFWwindow* window, int width, int height)
{
    glViewport(0, 0, width, height);
}